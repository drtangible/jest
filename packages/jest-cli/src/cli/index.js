/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {AggregatedResult} from 'types/TestResult';
import type {Argv} from 'types/Argv';
import type {GlobalConfig, Path, ProjectConfig} from 'types/Config';

import {
  Console,
  clearLine,
  createDirectory,
  realpath,
  validateCLIOptions,
} from 'jest-util';
import {readConfig} from 'jest-config';
import {version as VERSION} from '../../package.json';
import * as args from './args';
import chalk from 'chalk';
import createContext from '../lib/create_context';
import getChangedFilesPromise from '../get_changed_files_promise';
import getJest from './get_jest';
import handleDeprecationWarnings from '../lib/handle_deprecation_warnings';
import logDebugMessages from '../lib/log_debug_messages';
import {print as preRunMessagePrint} from '../pre_run_message';
import runJest from '../run_jest';
import Runtime from 'jest-runtime';
import TestWatcher from '../test_watcher';
import watch from '../watch';
import yargs from 'yargs';
import rimraf from 'rimraf';

export async function run(maybeArgv?: Argv, project?: Path) {
  try {
    const argv: Argv = buildArgv(maybeArgv, project);
    const projects = getProjectListFromCLIArgs(argv, project);
    // If we're running a single Jest project, we might want to use another
    // version of Jest (the one that is specified in this project's package.json)
    const runCLIFn = getRunCLIFn(projects);

    const {results, globalConfig} = await runCLIFn(argv, projects);
    readResultsAndExit(results, globalConfig);
  } catch (error) {
    clearLine(process.stderr);
    clearLine(process.stdout);
    console.error(chalk.red(error.stack));
    process.exit(1);
    throw error;
  }
}

export const runCLI = async (
  argv: Argv,
  projects: Array<Path>,
): Promise<{results: AggregatedResult, globalConfig: GlobalConfig}> => {
  const realFs = require('fs');
  const fs = require('graceful-fs');
  fs.gracefulify(realFs);

  let results;

  // If we output a JSON object, we can't write anything to stdout, since
  // it'll break the JSON structure and it won't be valid.
  const outputStream =
    argv.json || argv.useStderr ? process.stderr : process.stdout;

  argv.version && printVersionAndExit(outputStream);

  const {globalConfig, configs, hasDeprecationWarnings} = getConfigs(
    projects,
    argv,
    outputStream,
  );

  if (argv.clearCache) {
    configs.forEach(config => {
      rimraf.sync(config.cacheDirectory);
      process.stdout.write(`Cleared ${config.cacheDirectory}\n`);
    });

    process.exit(0);
  }

  await _run(
    globalConfig,
    configs,
    hasDeprecationWarnings,
    outputStream,
    (r: AggregatedResult) => (results = r),
  );

  if (argv.watch || argv.watchAll) {
    // If in watch mode, return the promise that will never resolve.
    // If the watch mode is interrupted, watch should handle the process
    // shutdown.
    return new Promise(() => {});
  }

  if (!results) {
    throw new Error(
      'AggregatedResult must be present after test run is complete',
    );
  }

  return Promise.resolve({globalConfig, results});
};

const readResultsAndExit = (
  result: ?AggregatedResult,
  globalConfig: GlobalConfig,
) => {
  const code = !result || result.success ? 0 : globalConfig.testFailureExitCode;
  process.on('exit', () => process.exit(code));
  if (globalConfig.forceExit) {
    process.exit(code);
  }
};

const buildArgv = (maybeArgv: ?Argv, project: ?Path) => {
  const argv: Argv = yargs(maybeArgv || process.argv.slice(2))
    .usage(args.usage)
    .alias('help', 'h')
    .options(args.options)
    .epilogue(args.docs)
    .check(args.check)
    .version(false).argv;

  validateCLIOptions(argv, args.options);

  return argv;
};

const getProjectListFromCLIArgs = (argv, project: ?Path) => {
  const projects = argv.projects ? argv.projects : [];

  if (project) {
    projects.push(project);
  }

  if (!projects.length && process.platform === 'win32') {
    try {
      projects.push(realpath(process.cwd()));
    } catch (err) {
      // do nothing, just catch error
      // process.binding('fs').realpath can throw, e.g. on mapped drives
    }
  }

  if (!projects.length) {
    projects.push(process.cwd());
  }

  return projects;
};

const getRunCLIFn = (projects: Array<Path>) =>
  projects.length === 1 ? getJest(projects[0]).runCLI : runCLI;

const printDebugInfoAndExitIfNeeded = (
  argv,
  globalConfig,
  configs,
  outputStream,
) => {
  if (argv.debug || argv.showConfig) {
    logDebugMessages(globalConfig, configs, outputStream);
  }
  if (argv.showConfig) {
    process.exit(0);
  }
};

const printVersionAndExit = outputStream => {
  outputStream.write(`v${VERSION}\n`);
  process.exit(0);
};

const ensureNoDuplicateConfigs = (parsedConfigs, projects) => {
  const configPathSet = new Set();

  for (const {configPath} of parsedConfigs) {
    if (configPathSet.has(configPath)) {
      let message =
        'One or more specified projects share the same config file\n';

      parsedConfigs.forEach(({configPath}, index) => {
        message =
          message +
          '\nProject: "' +
          projects[index] +
          '"\nConfig: "' +
          String(configPath) +
          '"';
      });
      throw new Error(message);
    }
    configPathSet.add(configPath);
  }
};

// Possible scenarios:
//  1. jest --config config.json
//  2. jest --projects p1 p2
//  3. jest --projects p1 p2 --config config.json
//  4. jest --projects p1
//  5. jest
//
// If no projects are specified, process.cwd() will be used as the default
// (and only) project.
const getConfigs = (
  projectsFromCLIArgs: Array<Path>,
  argv: Argv,
  outputStream,
): {
  globalConfig: GlobalConfig,
  configs: Array<ProjectConfig>,
  hasDeprecationWarnings: boolean,
} => {
  let globalConfig;
  let hasDeprecationWarnings;
  let configs: Array<ProjectConfig> = [];
  let projects = projectsFromCLIArgs;

  if (projectsFromCLIArgs.length === 1) {
    const parsedConfig = readConfig(argv, projects[0]);

    if (parsedConfig.globalConfig.projects) {
      // If this was a single project, and its config has `projects`
      // settings, use that value instead.
      projects = parsedConfig.globalConfig.projects;
    }

    hasDeprecationWarnings = parsedConfig.hasDeprecationWarnings;
    globalConfig = parsedConfig.globalConfig;
    configs = [parsedConfig.projectConfig];
    if (globalConfig.projects && globalConfig.projects.length) {
      // Even though we had one project in CLI args, there might be more
      // projects defined in the config.
      projects = globalConfig.projects;
    }
  }

  if (projects.length > 1) {
    const parsedConfigs = projects.map(root => readConfig(argv, root, true));
    ensureNoDuplicateConfigs(parsedConfigs, projects);
    configs = parsedConfigs.map(({projectConfig}) => projectConfig);
    if (!hasDeprecationWarnings) {
      hasDeprecationWarnings = parsedConfigs.some(
        ({hasDeprecationWarnings}) => !!hasDeprecationWarnings,
      );
    }
    // If no config was passed initially, use the one from the first project
    if (!globalConfig) {
      globalConfig = parsedConfigs[0].globalConfig;
    }
  }

  if (!globalConfig || !configs.length) {
    throw new Error('jest: No configuration found for any project.');
  }

  printDebugInfoAndExitIfNeeded(argv, globalConfig, configs, outputStream);

  return {
    configs,
    globalConfig,
    hasDeprecationWarnings: !!hasDeprecationWarnings,
  };
};

const buildContextsAndHasteMaps = async (
  configs,
  globalConfig,
  outputStream,
) => {
  const hasteMapInstances = Array(configs.length);
  const contexts = await Promise.all(
    configs.map(async (config, index) => {
      createDirectory(config.cacheDirectory);
      const hasteMapInstance = Runtime.createHasteMap(config, {
        console: new Console(outputStream, outputStream),
        maxWorkers: globalConfig.maxWorkers,
        resetCache: !config.cache,
        watch: globalConfig.watch || globalConfig.watchAll,
        watchman: globalConfig.watchman,
      });
      hasteMapInstances[index] = hasteMapInstance;
      return createContext(config, await hasteMapInstance.build());
    }),
  );

  return {contexts, hasteMapInstances};
};

const _run = async (
  globalConfig,
  configs,
  hasDeprecationWarnings,
  outputStream,
  onComplete,
) => {
  // Queries to hg/git can take a while, so we need to start the process
  // as soon as possible, so by the time we need the result it's already there.
  const changedFilesPromise = getChangedFilesPromise(globalConfig, configs);

  const {contexts, hasteMapInstances} = await buildContextsAndHasteMaps(
    configs,
    globalConfig,
    outputStream,
  );

  globalConfig.watch || globalConfig.watchAll
    ? await runWatch(
        contexts,
        configs,
        hasDeprecationWarnings,
        globalConfig,
        outputStream,
        hasteMapInstances,
        changedFilesPromise,
      )
    : await runWithoutWatch(
        globalConfig,
        contexts,
        outputStream,
        onComplete,
        changedFilesPromise,
      );
};

const runWatch = async (
  contexts,
  configs,
  hasDeprecationWarnings,
  globalConfig,
  outputStream,
  hasteMapInstances,
  changedFilesPromise,
) => {
  if (hasDeprecationWarnings) {
    try {
      await handleDeprecationWarnings(outputStream, process.stdin);
      return watch(globalConfig, contexts, outputStream, hasteMapInstances);
    } catch (e) {
      process.exit(0);
    }
  }

  return watch(globalConfig, contexts, outputStream, hasteMapInstances);
};

const runWithoutWatch = async (
  globalConfig,
  contexts,
  outputStream,
  onComplete,
  changedFilesPromise,
) => {
  const startRun = async () => {
    if (!globalConfig.listTests) {
      preRunMessagePrint(outputStream);
    }
    return await runJest({
      changedFilesPromise,
      contexts,
      failedTestsCache: null,
      globalConfig,
      onComplete,
      outputStream,
      startRun,
      testWatcher: new TestWatcher({isWatchMode: false}),
    });
  };
  return await startRun();
};
