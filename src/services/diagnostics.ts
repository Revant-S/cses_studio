import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Logger } from '../core/logger';

export interface CapturedPage {
  readonly label: string;
  readonly status: number;
  readonly url: string;
  readonly body: string;
}

export class DiagnosticsRecorder {
  private readonly log: Logger;

  constructor(
    logger: Logger,
    private readonly directory: string = path.join(os.tmpdir(), 'cses-studio-diagnostics'),
  ) {
    this.log = logger.scoped('diagnostics');
  }

  /** Returns the file path written, or undefined if capture failed. */
  async capture(name: string, pages: readonly CapturedPage[]): Promise<string | undefined> {
    try {
      await fs.mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, `${name}-${Date.now()}.html`);

      const sections = pages.map((page) =>
        [
          `<!-- ===== ${page.label} =====`,
          `     HTTP ${page.status}`,
          `     ${page.url}`,
          `-->`,
          redact(page.body),
        ].join('\n'),
      );

      await fs.writeFile(
        file,
        [
          '<!-- CSES Studio diagnostic capture',
          '     CSRF tokens are REDACTED. Response bodies never contain cookies.',
          '-->',
          ...sections,
        ].join('\n\n'),
        'utf8',
      );

      this.log.info(`Captured failing response(s) to ${file}`);
      return file;
    } catch (error) {
      this.log.warn(`Could not write diagnostics: ${String(error)}`);
      return undefined;
    }
  }
}

export function redact(html: string): string {
  return html
    .replace(/(name=["']csrf_token["'][^>]*value=["'])[^"']*(["'])/gi, '$1REDACTED$2')
    .replace(/(value=["'])([^"']*)(["'][^>]*name=["']csrf_token["'])/gi, '$1REDACTED$3');
}
