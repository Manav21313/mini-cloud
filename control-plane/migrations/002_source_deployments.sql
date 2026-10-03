ALTER TABLE applications
    ADD COLUMN repository_url TEXT,
    ADD COLUMN branch TEXT,
    ADD COLUMN last_deployed_at TIMESTAMPTZ,
    ADD COLUMN build_status TEXT;

ALTER TABLE applications ADD CONSTRAINT applications_source_metadata CHECK (
    (repository_url IS NULL AND branch IS NULL AND build_status IS NULL)
    OR (repository_url IS NOT NULL AND branch IS NOT NULL AND build_status = 'succeeded')
);
-- docker_image already stores the image name/tag, including source-built images.
