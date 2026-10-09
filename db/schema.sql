CREATE TABLE IF NOT EXISTS product_mappings (
 id BIGSERIAL PRIMARY KEY, itemku_product_id BIGINT NOT NULL UNIQUE,
 itemku_product_name TEXT NOT NULL, itemku_game_name TEXT, itemku_price BIGINT,
 supplier_sku TEXT, supplier_product_name TEXT, supplier_category TEXT, supplier_price BIGINT,
 enabled BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS order_jobs (
 id BIGSERIAL PRIMARY KEY, itemku_order_id BIGINT NOT NULL UNIQUE, itemku_order_number TEXT,
 itemku_product_id BIGINT NOT NULL, itemku_product_name TEXT, customer_user_id TEXT,
 customer_server_id TEXT, itemku_order_payload JSONB NOT NULL, supplier_reference_id TEXT NOT NULL UNIQUE,
 supplier_order_id TEXT, supplier_status TEXT NOT NULL DEFAULT 'queued',
 itemku_status TEXT NOT NULL DEFAULT 'REQUIRE_PROCESS', state TEXT NOT NULL DEFAULT 'queued',
 last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS system_logs (
 id BIGSERIAL PRIMARY KEY, level TEXT NOT NULL DEFAULT 'info', event TEXT NOT NULL,
 message TEXT, metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_jobs_state ON order_jobs(state,updated_at);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);
