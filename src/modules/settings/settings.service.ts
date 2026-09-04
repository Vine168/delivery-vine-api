import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisKey } from '../../common/constants/redis-keys.js';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
import { SETTINGS_BY_KEY, SETTINGS_CATALOGUE, type SettingDefinition } from './settings.catalogue.js';

/** Long enough that the matcher does not query Postgres per round; short
 *  enough that an operator sees their change take effect while still looking
 *  at the screen. Writes invalidate it anyway — this is only a backstop for
 *  other instances. */
const CACHE_TTL_SECONDS = 30;

export interface SettingView extends SettingDefinition {
  /** What the platform is using right now. */
  value: number | boolean;
  /** The deployment's own value, used when nothing is stored. */
  defaultValue: number | boolean;
  /** Whether an operator has overridden the deployment default. */
  isOverridden: boolean;
  updatedAt: string | null;
}

/**
 * Runtime settings an operator can change without a deploy.
 *
 * Values are read through a short Redis cache because the matcher asks for
 * them on every dispatch round. Nothing is invented: every key comes from the
 * catalogue, and a key with nothing stored falls back to the deployment's own
 * configuration, so an empty settings table behaves exactly like the platform
 * did before this existed.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** A whole number setting — falls back to the deployment's configuration. */
  async getNumber(key: string): Promise<number> {
    const definition = this.definitionFor(key);
    const stored = (await this.stored())[key];
    return typeof stored === 'number' ? stored : this.fallback(definition) as number;
  }

  async getBoolean(key: string): Promise<boolean> {
    const definition = this.definitionFor(key);
    const stored = (await this.stored())[key];
    return typeof stored === 'boolean' ? stored : this.fallback(definition) as boolean;
  }

  /** Several at once, so a caller needing five values makes one cache read. */
  async getNumbers<K extends string>(keys: readonly K[]): Promise<Record<K, number>> {
    const stored = await this.stored();

    return Object.fromEntries(
      keys.map((key) => {
        const definition = this.definitionFor(key);
        const value = stored[key];
        return [key, typeof value === 'number' ? value : (this.fallback(definition) as number)];
      }),
    ) as Record<K, number>;
  }

  async findAll(): Promise<SettingView[]> {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: SETTINGS_CATALOGUE.map((setting) => setting.key) } },
      select: { key: true, value: true, updatedAt: true },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    return SETTINGS_CATALOGUE.map((definition) => {
      const row = byKey.get(definition.key);
      const stored = row?.value as number | boolean | null | undefined;
      const fallback = this.fallback(definition);

      return {
        ...definition,
        value: stored ?? fallback,
        defaultValue: fallback,
        isOverridden: stored !== undefined && stored !== null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  }

  async findOne(key: string): Promise<SettingView> {
    const setting = (await this.findAll()).find((entry) => entry.key === key);
    if (!setting) throw AppException.notFound(ResponseCode.SETTING_NOT_FOUND);
    return setting;
  }

  /**
   * Stores an override. Validated against the catalogue, so a typo cannot
   * write a key nothing reads, and a value outside the sane range is refused
   * rather than quietly breaking dispatch.
   */
  async set(key: string, value: number | boolean, actorUserId: string): Promise<SettingView> {
    const definition = this.definitionFor(key);
    this.assertValid(definition, value);

    await this.prisma.systemSetting.upsert({
      where: { key },
      create: {
        key,
        category: definition.category,
        value,
        description: definition.description,
        updatedByUserId: actorUserId,
      },
      update: { value, category: definition.category, updatedByUserId: actorUserId },
    });

    await this.invalidate();
    return this.findOne(key);
  }

  /** Drops the override, returning the key to the deployment's own value. */
  async reset(key: string): Promise<SettingView> {
    this.definitionFor(key);
    await this.prisma.systemSetting.deleteMany({ where: { key } });
    await this.invalidate();
    return this.findOne(key);
  }

  async invalidate(): Promise<void> {
    await this.redis.client.del(RedisKey.systemSettings);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async stored(): Promise<Record<string, number | boolean>> {
    const cached = await this.redis.getJson<Record<string, number | boolean>>(RedisKey.systemSettings);
    if (cached) return cached;

    const rows = await this.prisma.systemSetting.findMany({ select: { key: true, value: true } });
    const values = Object.fromEntries(
      rows
        .filter((row) => SETTINGS_BY_KEY.has(row.key))
        .map((row) => [row.key, row.value as number | boolean]),
    );

    await this.redis.setJson(RedisKey.systemSettings, values, CACHE_TTL_SECONDS);
    return values;
  }

  private definitionFor(key: string): SettingDefinition {
    const definition = SETTINGS_BY_KEY.get(key);
    if (!definition) {
      throw AppException.notFound(
        ResponseCode.SETTING_NOT_FOUND,
        `${key} is not a setting this platform recognises.`,
      );
    }
    return definition;
  }

  private fallback(definition: SettingDefinition): number | boolean {
    return definition.kind === 'boolean'
      ? this.config.get<boolean>(definition.configPath, false)
      : this.config.get<number>(definition.configPath, 0);
  }

  private assertValid(definition: SettingDefinition, value: number | boolean): void {
    if (definition.kind === 'boolean') {
      if (typeof value !== 'boolean') {
        throw AppException.badRequest(ResponseCode.VALIDATION_ERROR, `${definition.label} must be true or false.`);
      }
      return;
    }

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw AppException.badRequest(
        ResponseCode.VALIDATION_ERROR,
        `${definition.label} must be a whole number.`,
      );
    }

    const unit = definition.unit ? ` ${definition.unit}` : '';
    if (definition.min !== undefined && value < definition.min) {
      throw AppException.badRequest(
        ResponseCode.VALIDATION_ERROR,
        `${definition.label} cannot be below ${definition.min}${unit}.`,
      );
    }
    if (definition.max !== undefined && value > definition.max) {
      throw AppException.badRequest(
        ResponseCode.VALIDATION_ERROR,
        `${definition.label} cannot be above ${definition.max}${unit}.`,
      );
    }
  }
}
