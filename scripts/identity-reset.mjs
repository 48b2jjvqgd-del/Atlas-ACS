#!/usr/bin/env node
/**
 * Re-imports the local Keycloak realm from infrastructure/docker/keycloak/atlas-realm.json.
 *
 * Keycloak imports a realm only when it does not exist yet, so after the realm file or its
 * secrets change, the local Keycloak database is recreated and Keycloak restarted. This affects
 * only the local, synthetic identity data in the `keycloak` database; ATLAS data is untouched.
 */
import { execFileSync } from 'node:child_process';

const run = (args) => execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });
run(['--profile', 'identity', 'stop', 'keycloak']);
run([
  'exec',
  '-T',
  'postgres',
  'sh',
  '-c',
  'dropdb -U "$POSTGRES_USER" --if-exists --force keycloak && createdb -U "$POSTGRES_USER" keycloak',
]);
run(['--profile', 'identity', 'up', '-d', '--wait', 'keycloak']);
console.log('Keycloak realm re-imported.');
