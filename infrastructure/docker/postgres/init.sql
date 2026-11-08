-- Runs once, on first initialisation of the local PostgreSQL volume.
-- Service schemas are NOT created here: each owner's migrations create its own schema.
-- Keycloak gets its own database so identity data is never mixed with ATLAS service data.
CREATE DATABASE keycloak;
