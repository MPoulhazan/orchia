#!/usr/bin/env node
// Entry point of the npm package: runs the server's TypeScript sources through tsx.
import { register } from 'tsx/esm/api';

register();
await import('../server/index.ts');
