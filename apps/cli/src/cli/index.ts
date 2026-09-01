#!/usr/bin/env node

import { Command, CommanderError } from 'commander';

import { CliUsageError, writeCliError } from './errors.js';
import {
  callArtifactTool,
  listArtifactAnnotations,
  listArtifactTools,
  resolveArtifactAnnotation,
} from './instance-api.js';
import {
  archiveArtifactInstance,
  listArtifactInstances,
  moveArtifactInstance,
  registerArtifactInstance,
  restoreArtifactInstance,
  startArtifactInstance,
  stopArtifactInstance,
} from './instance.js';
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
  .description('Create and start a new Artifact Instance')
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

const instance = program
  .command('instance')
  .description('Manage persistent Artifact Instances')
  .helpCommand(false);

instance
  .command('list')
  .description('List registered Artifact Instances')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (options: { json: boolean }) => {
    try {
      await listArtifactInstances(options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

instance
  .command('start')
  .description('Start a stopped Artifact Instance')
  .argument('<id-or-bundle-path>', 'registered Instance ID or .openartifact path')
  .option('--json', 'emit stable machine-readable output', false)
  .option('--no-open', 'do not open the system browser')
  .action(async (identifier: string, options: { json: boolean; open: boolean }) => {
    try {
      await startArtifactInstance(identifier, options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

instance
  .command('stop')
  .description('Stop an Active Artifact Instance')
  .argument('<id>', 'required Artifact Instance ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (id: string, options: { json: boolean }) => {
    try {
      await stopArtifactInstance(id, options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

instance
  .command('archive')
  .description('Archive a stopped Artifact Instance')
  .argument('<id>', 'required Artifact Instance ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (id: string, options: { json: boolean }) => {
    try {
      await archiveArtifactInstance(id, options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

instance
  .command('restore')
  .description('Restore an archived Artifact Instance to stopped')
  .argument('<id>', 'required Artifact Instance ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (id: string, options: { json: boolean }) => {
    try {
      await restoreArtifactInstance(id, options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

instance
  .command('move')
  .description('Move a non-active Artifact Instance Bundle')
  .argument('<id>', 'required Artifact Instance ID')
  .argument('<destination.openartifact>', 'new Instance Bundle path')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (id: string, destination: string, options: { json: boolean }) => {
    try {
      await moveArtifactInstance(id, destination, options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

instance
  .command('register')
  .description('Register the current path of an existing Instance Bundle')
  .argument('<bundle-path>', 'existing .openartifact path')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (bundlePath: string, options: { json: boolean }) => {
    try {
      await registerArtifactInstance(bundlePath, options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

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

const tool = program
  .command('tool')
  .description('Discover and call Artifact Tools')
  .helpCommand(false);

tool
  .command('list')
  .description('List Tools registered by an Active Artifact Instance')
  .requiredOption('--instance <id>', 'required Artifact Instance ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (options: { instance: string; json: boolean }) => {
    try {
      await listArtifactTools(options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

tool
  .command('call')
  .description('Call one Tool registered by an Active Artifact Instance')
  .argument('<name>', 'required Tool name')
  .requiredOption('--instance <id>', 'required Artifact Instance ID')
  .option('--base-revision <revision>', 'Data revision observed before a write Tool Call')
  .option('--data <json>', 'read Tool input from inline JSON')
  .option('--idempotency-key <key>', 'reuse one mutation receipt')
  .option('--json', 'emit stable machine-readable output', false)
  .action(
    async (
      name: string,
      options: {
        baseRevision?: string;
        data?: string;
        idempotencyKey?: string;
        instance: string;
        json: boolean;
      },
    ) => {
      try {
        await callArtifactTool(name, options);
      } catch (error) {
        writeCliError(error, options.json);
        process.exitCode = 1;
      }
    },
  );

const annotation = program
  .command('annotation')
  .description('Read Artifact Instance Annotations')
  .helpCommand(false);

annotation
  .command('list')
  .description('List Annotations stored by an Active Artifact Instance')
  .requiredOption('--instance <id>', 'required Artifact Instance ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (options: { instance: string; json: boolean }) => {
    try {
      await listArtifactAnnotations(options);
    } catch (error) {
      writeCliError(error, options.json);
      process.exitCode = 1;
    }
  });

annotation
  .command('resolve')
  .description('Resolve one Annotation against the current Instance Data')
  .argument('<id>', 'required Annotation ID')
  .requiredOption('--instance <id>', 'required Artifact Instance ID')
  .option('--json', 'emit stable machine-readable output', false)
  .action(async (id: string, options: { instance: string; json: boolean }) => {
    try {
      await resolveArtifactAnnotation(id, options);
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
