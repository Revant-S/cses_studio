export type Language = 'cpp' | 'python';

export interface CsesConfiguration {
  readonly language: Language;
  readonly workspaceRoot: string;
  readonly cppCompiler: string;
  readonly cppArgs: readonly string[];
  readonly pythonCompiler: string;
  readonly cppTemplate: string;
  readonly pythonTemplate: string;
  readonly autoFetch: boolean;
  readonly autoGenerateSamples: boolean;
  readonly autoOpenStatement: boolean;
  readonly timeLimitFactor: number;
  readonly trimTrailingWhitespace: boolean;
  readonly concurrency: number;
  /** Base font size for the statement webview, in px. */
  readonly statementFontSize: number;
  /** Explicit AtCoder language id; 0 picks automatically from the submit page. */
  readonly atcoderLanguageId: number;
  /** Problems drafted into a new practice contest. */
  readonly contestProblems: number;
  /** Default practice contest length, in minutes. */
  readonly contestMinutes: number;
}

export const DEFAULT_CPP_TEMPLATE = `#include <bits/stdc++.h>
using namespace std;

using ll = long long;

void solve() {

}

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    solve();
}
`;

export const DEFAULT_PYTHON_TEMPLATE = `import sys

input = sys.stdin.readline


def solve() -> None:
    pass


def main() -> None:
    solve()


if __name__ == "__main__":
    main()
`;

/** Supplies effective settings to the service layer. */
export interface ConfigurationProvider {
  get(): CsesConfiguration;
}

/** Baseline used by tests and as the fallback for unset settings. */
export function defaultConfiguration(
  overrides: Partial<CsesConfiguration> = {},
): CsesConfiguration {
  return {
    language: 'cpp',
    workspaceRoot: '',
    cppCompiler: 'g++',
    cppArgs: ['-std=c++17', '-O2', '-Wall'],
    pythonCompiler: 'python3',
    cppTemplate: DEFAULT_CPP_TEMPLATE,
    pythonTemplate: DEFAULT_PYTHON_TEMPLATE,
    autoFetch: true,
    autoGenerateSamples: true,
    autoOpenStatement: true,
    timeLimitFactor: 2,
    trimTrailingWhitespace: true,
    concurrency: 6,
    statementFontSize: 15,
    atcoderLanguageId: 0,
    contestProblems: 4,
    contestMinutes: 90,
    ...overrides,
  };
}

/** Fixed-configuration provider, for tests and headless tooling. */
export class StaticConfigurationProvider implements ConfigurationProvider {
  constructor(private readonly value: CsesConfiguration) {}

  get(): CsesConfiguration {
    return this.value;
  }
}

export function fileExtensionFor(language: Language): string {
  return language === 'cpp' ? 'cpp' : 'py';
}

export function languageForExtension(extension: string): Language | undefined {
  const normalized = extension.replace(/^\./, '').toLowerCase();
  if (['cpp', 'cc', 'cxx', 'c++'].includes(normalized)) {
    return 'cpp';
  }
  if (normalized === 'py') {
    return 'python';
  }
  return undefined;
}
