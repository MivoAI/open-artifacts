#!/usr/bin/env node

import { Command, CommanderError } from 'commander';

import { CliUsageError, writeCliError } from './errors.js';
import { runArtifactPackage } from './run.js';
import { listArtifactSessions, stopArtifactSession } from './session.js';

const program = new Command();
const rawArguments = process.argv.slice(2);
const optionTerminator = rawArguments.indexOf('--');
const jsonRequested = rawArguments
  .slice(0, optionTerminator === -1 ? rawArguments.length : optionTerminator)
  .includes('--json');
let commanderOutput = '';

program
  .name('oa')
  .description('Run source-published Open Artifacts as local browser sessions.')
  .version('0.1.0')
  .helpCommand(false)
  .exitOverride()
  .configureOutput({
    writeOut: (text) => {
      if (jsonRequested) commanderOutput += text;
      else process.stdout.write(text);
    },
    writeErr: (text) => {
      if (!jsonRequested) process.stderr.write(text);
    },
  });

const runCommand = program
  .command('run')
  .description('Start a new Artifact Session')
  .argument('<artifact>', 'local or npm Artifact Reference')
  .option('--input <file>', 'read Artifact Input from a JSON file')
  .option('--data <json>', 'read Artifact Input from inline JSON')
  .option('--json', 'emit stable machine-readable output', false)
  .option('--no-open', 'do not open the system browser')
  .action(
    async (
      artifact: string,
      options: { data?: string; input?: string; json: boolean; open: boolean },
    ) => {
      try {
        await runArtifactPackage(artifact, options);
      } catch (error) {
        writeCliError(error, options.json);
        process.exitCode = 1;
      }
    },
  );

runCommand.addHelpText(
  'after',
  '\nSecurity: oa executes trusted Artifact Source without a security sandbox.\n',
);

const session = program
  .command('session')
  .description('Manage Active Artifact Sessions')
  .helpCommand(false);

session
  .command('list')
  .description('List reachable Active Sessions')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (options: { json: boolean }) => {
    try {
      await listArtifactSessions(options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

session
  .command('stop')
  .description('Stop one Artifact Session')
  .argument('<id>', 'required Session ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (id: string, options: { json: boolean }) => {
    try {
      await stopArtifactSession(id, options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
    if (jsonRequested) {
      process.stdout.write(`${JSON.stringify({ help: commanderOutput.trimEnd() })}\n`);
    }
    process.exitCode = error.exitCode;
  } else if (error instanceof CommanderError && error.code === 'commander.version') {
    if (jsonRequested) {
      process.stdout.write(`${JSON.stringify({ version: commanderOutput.trim() })}\n`);
    }
    process.exitCode = error.exitCode;
  } else if (error instanceof CommanderError) {
    if (jsonRequested) writeCliError(new CliUsageError(error.message), true);
    process.exitCode = error.exitCode || 1;
  } else {
    throw error;
  }
}
