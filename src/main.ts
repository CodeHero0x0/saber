#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";

import { runCli } from "./cli.js";

loadDotenv({ path: `${process.cwd()}/.env`, quiet: true });
const result = await runCli(process.argv.slice(2));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
