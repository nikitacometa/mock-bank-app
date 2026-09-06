import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const mainPath = resolve('bot/dist/main.js');
const repositoryPath = resolve('bot/dist/repository.js');

await Promise.all([access(mainPath), access(repositoryPath)]);
const repositoryModule = await import(pathToFileURL(repositoryPath).href);
if (typeof repositoryModule.PreferencesRepository !== 'function') {
  throw new Error('Bot bundle does not expose PreferencesRepository for database probes');
}

process.stdout.write('Bot bundle contract passed.\n');
