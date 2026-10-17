-- Self-service company signup. The app role may not write tenants directly; this function creates
-- just the tenant row (as the migration owner). Settings, pipeline and the admin are then written by
-- the caller inside the new tenant's context, under row-level security.
CREATE FUNCTION create_tenant_row(p_name TEXT, p_slug TEXT)
RETURNS TABLE (id UUID, name TEXT, slug TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO tenants (name, slug) VALUES (p_name, p_slug) RETURNING tenants.id, tenants.name, tenants.slug;
$$;
