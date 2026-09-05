import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OtpChannel } from '../../../generated/prisma/enums.js';
import { PlasGateOtpSender } from './plasgate-otp-sender.js';

const SETTINGS: Record<string, unknown> = {
  'sms.baseUrl': 'https://gateway.test/rest/send',
  'sms.privateKey': 'private-key',
  'sms.secretKey': '$5$rounds=535000$salt$hash',
  'sms.sender': 'Deliver',
  'sms.timeoutMs': 5_000,
};

const config = {
  get: (key: string, fallback?: unknown) => SETTINGS[key] ?? fallback,
  getOrThrow: (key: string) => SETTINGS[key],
} as unknown as ConfigService;

const MESSAGE = {
  identifier: '+85512345678',
  channel: OtpChannel.SMS,
  code: '482913',
  ttlSeconds: 300,
};

function reply(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('PlasGateOtpSender', () => {
  let sender: PlasGateOtpSender;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sender = new PlasGateOtpSender(config);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('sending', () => {
    it('posts the code to the gateway with both credentials', async () => {
      fetchMock.mockResolvedValue(reply({ queue_id: 'q-1', message_count: 1 }));

      await sender.send(MESSAGE);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('https://gateway.test/rest/send');
      // The private key rides in the query string, the secret in a header.
      expect(url).toContain('private_key=private-key');
      expect((init.headers as Record<string, string>)['X-Secret']).toBe(SETTINGS['sms.secretKey']);

      const body = JSON.parse(init.body as string) as Record<string, string>;
      expect(body).toMatchObject({ sender: 'Deliver', to: '+85512345678' });
      expect(body.content).toContain('482913');
      expect(body.content).toContain('5 minutes');
      expect(body.content).toMatch(/do not share/i);
    });

    it('treats a reply without a queue id as a failure, whatever the status', async () => {
      // The gateway answers 200 with an error object often enough that
      // trusting the status code alone would drop codes silently.
      fetchMock.mockResolvedValue(reply({ message: 'insufficient balance' }));

      await expect(sender.send(MESSAGE)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });

    it('fails when the gateway rejects the request', async () => {
      fetchMock.mockResolvedValue(reply({ message: '412 No Route Found' }, false, 412));

      await expect(sender.send(MESSAGE)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });

    it('fails when the gateway cannot be reached at all', async () => {
      fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(sender.send(MESSAGE)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });

    it('refuses email rather than quietly texting the code instead', async () => {
      await expect(sender.send({ ...MESSAGE, channel: OtpChannel.EMAIL })).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('keeping the code secret', () => {
    it('never puts it in the error a caller sees', async () => {
      fetchMock.mockResolvedValue(reply({ message: 'rejected' }, false, 400));

      await expect(sender.send(MESSAGE)).rejects.toSatisfy((error: Error) => {
        expect(JSON.stringify(error)).not.toContain('482913');
        expect(error.message).not.toContain('482913');
        return true;
      });
    });

    it('never puts it in a log line', async () => {
      const logged: string[] = [];
      const logger = sender['logger'] as { error: (m: string) => void; log: (m: string) => void };
      logger.error = (m: string) => logged.push(m);
      logger.log = (m: string) => logged.push(m);

      fetchMock.mockResolvedValue(reply({ queue_id: 'q-1' }));
      await sender.send(MESSAGE);

      fetchMock.mockResolvedValue(reply({ message: 'nope' }, false, 400));
      await sender.send(MESSAGE).catch(() => undefined);

      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join('\n')).not.toContain('482913');
    });

    it('masks the recipient, keeping just enough to trace a complaint', async () => {
      const logged: string[] = [];
      (sender['logger'] as { log: (m: string) => void }).log = (m: string) => logged.push(m);

      fetchMock.mockResolvedValue(reply({ queue_id: 'q-7' }));
      await sender.send(MESSAGE);

      expect(logged[0]).toContain('+8551****678');
      expect(logged[0]).not.toContain('+85512345678');
      expect(logged[0]).toContain('q-7');
    });
  });

  describe('configuration', () => {
    it('is considered configured only with all three credentials', () => {
      expect(PlasGateOtpSender.isConfigured(config)).toBe(true);

      const partial = {
        get: (key: string) => (key === 'sms.sender' ? undefined : SETTINGS[key]),
      } as unknown as ConfigService;
      expect(PlasGateOtpSender.isConfigured(partial)).toBe(false);
    });
  });
});
