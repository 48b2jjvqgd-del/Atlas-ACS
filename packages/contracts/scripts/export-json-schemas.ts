/** Writes every contract as a JSON Schema file to dist/json-schema/. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJsonSchemas } from '../src/index.js';

const outputDirectory = join(import.meta.dirname, '..', 'dist', 'json-schema');
await mkdir(outputDirectory, { recursive: true });
const documents = exportJsonSchemas();
for (const [key, document] of Object.entries(documents)) {
  await writeFile(
    join(outputDirectory, `${key}.schema.json`),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}
process.stdout.write(
  `Exported ${Object.keys(documents).length} JSON Schema documents to ${outputDirectory}\n`,
);
