import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { FileVisibility } from '../../generated/prisma/enums.js';
import { StorageService } from '../storage/storage.service.js';

/**
 * How long a file may sit attached to nothing before it counts as litter.
 *
 * There is always a gap between uploading a photo and saving the booking that
 * references it, so this has to be long enough that a customer who wandered
 * off mid-form and came back is never mistaken for garbage.
 */
const GRACE_DAYS = 7;

/** Removed per run, so one sweep cannot spend an hour talking to object storage. */
const MAX_PER_RUN = 500;

interface OrphanRow {
  id: string;
  objectKey: string;
  visibility: FileVisibility;
}

/**
 * Deletes uploaded files that nothing points at.
 *
 * Unlike a stray database row, every one of these has a monthly bill attached:
 * an abandoned booking's package photo, a retaken proof of delivery, the
 * documents of an applicant who was turned down. Nothing has ever removed
 * them.
 *
 * The dangerous version of this job hardcodes the list of tables that
 * reference a file, and quietly deletes a live proof-of-delivery photo the
 * first time someone adds a twelfth reference and forgets to update it. So the
 * list is not hardcoded: it is read from the database's own foreign keys on
 * every run, which means a new reference protects its files the moment the
 * migration lands, with nobody having to remember anything.
 */
@Injectable()
export class OrphanedFilesService {
  private readonly logger = new Logger(OrphanedFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async sweep(): Promise<{ found: number; removed: number; failed: number }> {
    const references = await this.referencesToFileAsset();

    if (references.length === 0) {
      // Something is wrong with the introspection rather than genuinely true;
      // treating every file as an orphan would empty the bucket.
      this.logger.error('No foreign keys to FileAsset found — refusing to sweep');
      return { found: 0, removed: 0, failed: 0 };
    }

    const orphans = await this.findOrphans(references);
    let removed = 0;
    let failed = 0;

    for (const file of orphans) {
      try {
        // Storage first: a failure here leaves the row, and the next run tries
        // again. Deleting the row first would lose the only record of which
        // object to remove, leaking it invisibly and forever.
        await this.storage.remove(file.objectKey, file.visibility);
        await this.prisma.fileAsset.delete({ where: { id: file.id } });
        removed += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(`Could not remove orphaned file ${file.objectKey}: ${String(error)}`);
      }
    }

    if (orphans.length > 0) {
      this.logger.log(
        `Orphaned files: ${removed} removed, ${failed} failed, from ${orphans.length} found`,
      );
    }

    return { found: orphans.length, removed, failed };
  }

  /**
   * Every column in the schema that points at a file, according to Postgres.
   *
   * Exposed so a test can assert the introspection sees what the schema
   * declares — the whole safety of this job rests on that list being complete.
   */
  async referencesToFileAsset(): Promise<{ table: string; column: string }[]> {
    return this.prisma.$queryRaw<{ table: string; column: string }[]>`
      SELECT c.conrelid::regclass::text AS table, a.attname AS column
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND c.confrelid = '"FileAsset"'::regclass
      ORDER BY 1, 2
    `;
  }

  private async findOrphans(references: { table: string; column: string }[]): Promise<OrphanRow[]> {
    const cutoff = new Date(Date.now() - GRACE_DAYS * 86_400_000);

    // Identifiers come from pg_constraint, never from a caller, and are quoted
    // as Postgres reported them.
    const notReferenced = references
      .map(({ table, column }) => `NOT EXISTS (SELECT 1 FROM ${table} r WHERE r."${column}" = f."id")`)
      .join('\n        AND ');

    return this.prisma.$queryRawUnsafe<OrphanRow[]>(
      `SELECT f."id", f."objectKey", f."visibility"
       FROM "FileAsset" f
       WHERE f."createdAt" < $1
         AND ${notReferenced}
       ORDER BY f."createdAt"
       LIMIT ${MAX_PER_RUN}`,
      cutoff,
    );
  }
}
