import { describe, expect, it } from 'vitest';
import { CsvWriter } from './csv.util.js';

describe('CsvWriter.escape', () => {
  it('leaves an ordinary value alone', () => {
    expect(CsvWriter.escape('ORD-20260903-00128')).toBe('ORD-20260903-00128');
    expect(CsvWriter.escape(15_800)).toBe('15800');
  });

  it('writes nothing for a missing value', () => {
    expect(CsvWriter.escape(null)).toBe('');
    expect(CsvWriter.escape(undefined)).toBe('');
  });

  it('quotes a field containing a comma, so an address stays one column', () => {
    expect(CsvWriter.escape('Street 271, Toul Kork')).toBe('"Street 271, Toul Kork"');
  });

  it('doubles embedded quotes', () => {
    expect(CsvWriter.escape('Sok "Dara" Chan')).toBe('"Sok ""Dara"" Chan"');
  });

  it('quotes a field containing a newline', () => {
    expect(CsvWriter.escape('Line one\nLine two')).toBe('"Line one\nLine two"');
  });

  it('neutralises anything a spreadsheet would run as a formula', () => {
    // The classic CSV injection payloads: a name or a note the platform stored
    // verbatim must not become code when someone opens the export.
    expect(CsvWriter.escape('=1+1')).toBe("'=1+1");
    expect(CsvWriter.escape('+cmd|calc')).toBe("'+cmd|calc");
    expect(CsvWriter.escape('-2+3')).toBe("'-2+3");
    expect(CsvWriter.escape('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('quotes a neutralised field that also contains a comma', () => {
    expect(CsvWriter.escape('=HYPERLINK("http://x","click")')).toBe(
      '"\'=HYPERLINK(""http://x"",""click"")"',
    );
  });

  it('leaves a negative number as a number', () => {
    // A leading minus is an injection vector, but `-500` is plainly a figure;
    // prefixing it would arrive as text and break the first person who tries
    // to sum the column.
    expect(CsvWriter.escape(-500)).toBe('-500');
    expect(CsvWriter.escape('-12.34')).toBe('-12.34');
    expect(CsvWriter.escape('-2+3')).toBe("'-2+3");
  });
});
