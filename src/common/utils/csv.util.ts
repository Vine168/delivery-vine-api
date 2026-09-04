import type { Response } from 'express';

/**
 * A CSV file, written straight to the response.
 *
 * Two things this handles that a `rows.map(r => r.join(',')).join('\n')` does
 * not. Fields are quoted whenever they contain a comma, a quote or a newline,
 * and embedded quotes are doubled — an address with a comma in it is otherwise
 * a corrupt file. And a field beginning with `=`, `+`, `-` or `@` is prefixed
 * with a quote, because spreadsheets treat those as formulas: a customer whose
 * name is `=cmd|...` should not become code the moment an operator opens the
 * export.
 */
export class CsvWriter {
  private wroteHeader = false;

  constructor(
    private readonly response: Response,
    private readonly columns: string[],
  ) {}

  /** Sends the headers that make a browser download the file. */
  start(filename: string): void {
    this.response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    this.response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Excel reads a file without this as Latin-1 and mangles Khmer names.
    this.response.write('﻿');
    this.response.write(`${this.columns.map((column) => CsvWriter.escape(column)).join(',')}\n`);
    this.wroteHeader = true;
  }

  write(values: (string | number | null | undefined)[]): void {
    if (!this.wroteHeader) {
      throw new Error('CsvWriter.start() must be called before writing rows.');
    }

    this.response.write(`${values.map((value) => CsvWriter.escape(value)).join(',')}\n`);
  }

  end(): void {
    this.response.end();
  }

  /** A plain decimal number, positive or negative — safe as it stands. */
  private static readonly NUMERIC = /^-?\d+(\.\d+)?$/;

  static escape(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '';

    const text = String(value);
    // Neutralise anything a spreadsheet would evaluate — but not an ordinary
    // negative number, which would otherwise arrive as text and break the
    // first person who tries to sum the column.
    const safe = /^[=+\-@\t\r]/.test(text) && !CsvWriter.NUMERIC.test(text) ? `'${text}` : text;

    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  }
}
