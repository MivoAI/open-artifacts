#!/usr/bin/env node

import { Command } from 'commander';

import { runArtifactPackage } from './run.js';

const program = new Command();

program
  .name('oa')
  .description('Run source-published Open Artifacts as local browser sessions.')
  .version('0.1.0');

program
  .command('run')
  .description('Start a new Artifact Session')
  .argument('<artifact>', 'explicit relative or absolute local Artifact Package path')
  .option('--json', 'emit stable machine-readable output', false)
  .option('--no-open', 'do not open the system browser')
  .action(async (artifact: string, options: { json: boolean; open: boolean }) => {
    await runArtifactPackage(artifact, options);
  });

await program.parseAsync();
