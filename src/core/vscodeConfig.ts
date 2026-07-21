import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  type ConfigurationProvider,
  type CsesConfiguration,
  DEFAULT_CPP_TEMPLATE,
  DEFAULT_PYTHON_TEMPLATE,
  type Language,
} from './config';

/** Reads the live `cses.*` workspace configuration. */
export class VsCodeConfigurationProvider implements ConfigurationProvider {
  get(): CsesConfiguration {
    const config = vscode.workspace.getConfiguration('cses');
    return {
      language: config.get<Language>('language', 'cpp'),
      workspaceRoot: resolveWorkspaceRoot(config.get<string>('workspaceRoot', '')),
      cppCompiler: config.get<string>('compiler.cpp', 'g++'),
      cppArgs: config.get<string[]>('compiler.cppArgs', ['-std=c++17', '-O2', '-Wall']),
      pythonCompiler: config.get<string>('compiler.python', 'python3'),
      cppTemplate: config.get<string>('template.cpp', '') || DEFAULT_CPP_TEMPLATE,
      pythonTemplate: config.get<string>('template.python', '') || DEFAULT_PYTHON_TEMPLATE,
      autoFetch: config.get<boolean>('autoFetch', true),
      autoGenerateSamples: config.get<boolean>('autoGenerateSamples', true),
      autoOpenStatement: config.get<boolean>('autoOpenStatement', true),
      timeLimitFactor: config.get<number>('timeLimitFactor', 2),
      trimTrailingWhitespace: config.get<boolean>('trimTrailingWhitespace', true),
      concurrency: config.get<number>('concurrency', 6),
      statementFontSize: config.get<number>('statementFontSize', 15),
      atcoderLanguageId: config.get<number>('atcoder.languageId', 0),
      contestProblems: config.get<number>('contest.problems', 4),
      contestMinutes: config.get<number>('contest.minutes', 90),
    };
  }
}

function resolveWorkspaceRoot(configured: string): string {
  if (configured.trim()) {
    return configured.startsWith('~')
      ? path.join(os.homedir(), configured.slice(1))
      : path.resolve(configured);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder && folder.uri.scheme === 'file') {
    return folder.uri.fsPath;
  }
  return path.join(os.homedir(), 'cses-studio');
}
