import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';

@ApiTags('Health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness — answers as long as the process is up. */
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness — answers only when the dependencies we cannot serve without are reachable. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Readiness probe (database + Redis)' })
  async ready(): Promise<{ status: string; database: string; redis: string; uptimeSeconds: number }> {
    const [database, redis] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1`
        .then(() => 'up')
        .catch(() => 'down'),
      this.redis.client
        .ping()
        .then(() => 'up')
        .catch(() => 'down'),
    ]);

    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      database,
      redis,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
