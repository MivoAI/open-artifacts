#!/usr/bin/env node

import { Command } from 'commander';

import { writeCliError } from './errors.js';
import { runArtifactPackage } from './run.js';
import { listArtifactSessions, SessionLifecycleError, stopArtifactSession } from './session.js';

const program = new Command();

program
  .name('oa')
  .description('Run source-published Open Artifacts as local browser sessions.')
  .version('0.1.0');

const runCommand = program
  .command('run')
  .description('Start a new Artifact Session')
  .argument('<artifact>', 'explicit relative or absolute local Artifact Package path')
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

const session = program.command('session').description('Manage Active Artifact Sessions');

session
  .command('list')
  .description('List reachable Active Sessions')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (options: { json: boolean }) => {
    await listArtifactSessions(options);
  });

session
  .command('stop')
  .description('Stop one Artifact Session')
  .argument('<id>', 'required Session ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (id: string, options: { json: boolean }) => {
    await stopArtifactSession(id, options);
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof SessionLifecycleError) {
    process.stderr.write(`oa: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
