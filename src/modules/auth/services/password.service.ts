import { Injectable } from '@nestjs/common';
import { argon2id, hash, needsRehash, verify, type HashOptions } from 'argon2';

/**
 * Argon2id with OWASP-recommended parameters. Isolated in its own service so
 * the cost parameters (and any future migration to different ones) live in one
 * place rather than being copied around the auth flows.
 */
@Injectable()
export class PasswordService {
  private readonly options: HashOptions & { raw?: false } = {
    type: argon2id,
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, this.options);
  }

  async verify(digest: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(digest, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * Burns roughly the same time as a real verification. Called when the account
   * does not exist, so response timing cannot be used to enumerate accounts.
   */
  async fakeVerify(): Promise<void> {
    await hash('timing-equaliser', this.options);
  }

  needsRehash(digest: string): boolean {
    return needsRehash(digest, {
      timeCost: this.options.timeCost,
      memoryCost: this.options.memoryCost,
    });
  }
}
