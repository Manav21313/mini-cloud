CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    docker_image TEXT NOT NULL CHECK (length(trim(docker_image)) > 0),
    container_name TEXT NOT NULL UNIQUE
        CHECK (container_name ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$'),
    container_port INTEGER NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
    host_port INTEGER NOT NULL UNIQUE CHECK (host_port BETWEEN 1 AND 65535),
    status TEXT NOT NULL DEFAULT 'not created',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
