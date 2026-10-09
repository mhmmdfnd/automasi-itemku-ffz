
const crypto = require("crypto");
const { Pool } = require("pg");

const IK = "https://tokoku-gateway.itemku.com/api";

const FFZ_GATEWAY = (process.env.FFZ_GATEWAY_URL || "").replace(/\/+$/, "");

let pool;

const db = () => {
  if (!process.env.DATABASE_URL) {
    throw Error("DATABASE_URL belum diatur");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
      max: 3
    });
  }

  return pool;
};

const equal = (a, b) => {
  a = Buffer.from(String(a || ""));
  b = Buffer.from(String(b || ""));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const auth = (req) => {
  const value =
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
    req.headers["x-app-secret"];

  return !!process.env.APP_SECRET &&
    equal(value, process.env.APP_SECRET);
};

const send = (res, status, data) => res.status(status).json(data);

async function call(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.success === false) {
    const error = Error(
      data.message || `HTTP ${response.status}`
    );

    error.status = response.status;
    error.details = data;

    throw error;
  }

  return data;
}

/*
 * Seluruh komunikasi FFZ melewati Cloudflare Worker.
 * Tidak ada permintaan langsung ke API FFZ dari Vercel.
 */
async function ffz(path, options = {}) {
  if (!FFZ_GATEWAY) {
    throw Error("FFZ_GATEWAY_URL belum diatur di Vercel");
  }

  if (!process.env.FFZ_GATEWAY_TOKEN) {
    throw Error("FFZ_GATEWAY_TOKEN belum diatur di Vercel");
  }

  const response = await fetch(FFZ_GATEWAY + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.FFZ_GATEWAY_TOKEN}`,
      Accept: "application/json",
      ...(options.body
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    result = { message: text.slice(0, 1000) };
  }

  if (
    !response.ok ||
    result.success === false ||
    (
      result.upstream_status &&
      result.upstream_status >= 400
    )
  ) {
    const upstream = result.data || result;

    const error = Error(
      upstream.message ||
      result.message ||
      `Gateway HTTP ${response.status}`
    );

    error.status =
      result.upstream_status || response.status;

    error.details = result;

    throw error;
  }

  // Mengembalikan respons asli FFZ, bukan pembungkus gateway.
  return result.data;
}

function ikToken(payload = {}) {
  if (
    !process.env.ITEMKU_API_KEY ||
    !process.env.ITEMKU_SECRET_KEY
  ) {
    throw Error(
      "ITEMKU_API_KEY / ITEMKU_SECRET_KEY belum diatur"
    );
  }

  const nonce = String(Math.floor(Date.now() / 1000));

  const base64url = (object) =>
    Buffer.from(JSON.stringify(object)).toString("base64url");

  const header = {
    "X-Api-Key": process.env.ITEMKU_API_KEY,
    Nonce: nonce,
    alg: "HS256"
  };

  const unsigned =
    base64url(header) + "." + base64url(payload);

  const signature = crypto
    .createHmac("sha256", process.env.ITEMKU_SECRET_KEY)
    .update(unsigned)
    .digest("base64url");

  return {
    nonce,
    token: unsigned + "." + signature
  };
}

async function ik(path, payload = {}) {
  const token = ikToken(payload);

  return call(IK + path, {
    method: "POST",
    headers: {
      "X-Api-Key": process.env.ITEMKU_API_KEY,
      Nonce: token.nonce,
      Authorization: "Bearer " + token.token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function log(level, event, message, metadata = {}) {
  try {
    await db().query(
      `INSERT INTO system_logs
       (level, event, message, metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        level,
        event,
        message,
        JSON.stringify(metadata)
      ]
    );
  } catch {}
}

async function products() {
  const all = [];

  for (let page = 1; page <= 5000; page++) {
    const response = await ik("/product/list", { page });

    const wrapper = response.data || {};

    const rows = Array.isArray(wrapper.data)
      ? wrapper.data
      : Array.isArray(response.data)
        ? response.data
        : [];

    all.push(...rows);

    if (
      !wrapper.next_page ||
      !rows.length ||
      wrapper.next_page <= page
    ) {
      break;
    }
  }

  return all;
}

async function itemOrders(id) {
  const response = await ik("/order/list", {
    date_start: new Date(
      Date.now() - 2 * 86400000
    ).toISOString().slice(0, 10),
    order_status: "REQUIRE_PROCESS",
    limit: 30
  });

  const rows = Array.isArray(response.data)
    ? response.data
    : [];

  const order = rows.find(
    (item) => String(item.order_id) === String(id)
  );

  if (!order) {
    throw Error(
      "Order tidak ditemukan dengan status REQUIRE_PROCESS di Itemku"
    );
  }

  return order;
}

function customer(order) {
  let information = order.required_information;

  if (typeof information === "string") {
    try {
      information = JSON.parse(information);
    } catch {
      information = {};
    }
  }

  information = information || {};

  return {
    user: String(
      information.player_id ??
      information.user_id ??
      information.userId ??
      information.uid ??
      information.id ??
      ""
    ).trim(),

    server: String(
      information.zone_id ??
      information.server_id ??
      information.serverId ??
      information.zoneId ??
      ""
    ).trim()
  };
}

async function queueOrder(order) {
  const customerInfo = customer(order);

  if (!customerInfo.user) {
    throw Error(
      "User ID tidak terbaca dari required_information"
    );
  }

  const existing = await db().query(
    "SELECT * FROM order_jobs WHERE itemku_order_id = $1",
    [order.order_id]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const mapping = await db().query(
    `SELECT * FROM product_mappings
     WHERE itemku_product_id = $1 AND enabled = true`,
    [order.product_id]
  );

  if (!mapping.rows[0]) {
    await db().query(
      `INSERT INTO order_jobs
       (
         itemku_order_id,
         itemku_order_number,
         itemku_product_id,
         itemku_product_name,
         itemku_order_payload,
         supplier_reference_id,
         state,
         last_error
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'needs_mapping',
               'Mapping belum aktif')
       ON CONFLICT DO NOTHING`,
      [
        order.order_id,
        order.order_number || null,
        order.product_id,
        order.product_name || null,
        JSON.stringify(order),
        "IK-" + order.order_id
      ]
    );

    throw Error(
      "Mapping produk belum aktif untuk Itemku product_id " +
      order.product_id
    );
  }

  const result = await db().query(
    `INSERT INTO order_jobs
     (
       itemku_order_id,
       itemku_order_number,
       itemku_product_id,
       itemku_product_name,
       customer_user_id,
       customer_server_id,
       itemku_order_payload,
       supplier_reference_id,
       state
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')
     ON CONFLICT (itemku_order_id)
     DO UPDATE SET itemku_order_id = EXCLUDED.itemku_order_id
     RETURNING *`,
    [
      order.order_id,
      order.order_number || null,
      order.product_id,
      order.product_name || mapping.rows[0].itemku_product_name,
      customerInfo.user,
      customerInfo.server || null,
      JSON.stringify(order),
      "IK-" + order.order_id
    ]
  );

  return result.rows[0];
}

async function worker() {
  const result = await db().query(
    `SELECT j.*, m.supplier_sku
     FROM order_jobs j
     JOIN product_mappings m
       ON m.itemku_product_id = j.itemku_product_id
     WHERE j.state IN ('queued', 'supplier_pending')
       AND m.enabled = true
     ORDER BY j.created_at
     LIMIT 10`
  );

  const jobs = result.rows;
  const output = [];

  for (const job of jobs) {
    try {
      if (!job.supplier_order_id) {
        const response = await ffz("/orders", {
          method: "POST",
          body: JSON.stringify({
            product_sku: job.supplier_sku,

            customer: {
              user_id: job.customer_user_id,
              ...(job.customer_server_id
                ? { server_id: job.customer_server_id }
                : {})
            },

            reference_id: job.supplier_reference_id,

            ...(process.env.APP_URL
              ? {
                  callback_url:
                    process.env.APP_URL + "/api/ffz-callback"
                }
              : {})
          })
        });

        const data = response.data || response;

        if (!data.order_id) {
          throw Error(
            "Respons FFZ tidak berisi order_id"
          );
        }

        await db().query(
          `UPDATE order_jobs
           SET supplier_order_id = $1,
               supplier_status = $2,
               state = 'supplier_pending',
               attempts = attempts + 1,
               updated_at = NOW()
           WHERE id = $3`,
          [
            data.order_id,
            data.status || "pending",
            job.id
          ]
        );

        output.push({
          id: job.itemku_order_id,
          state: "supplier_pending"
        });
      } else {
        const response = await ffz(
          "/orders/" + encodeURIComponent(job.supplier_order_id)
        );

        const data = response.data || response;
        const status = String(
          data.status || ""
        ).toLowerCase();

        await db().query(
          `UPDATE order_jobs
           SET supplier_status = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [status, job.id]
        );

        if (status === "success") {
          const deliveryInfo =
            data.fulfillment?.serial_number
              ? [String(data.fulfillment.serial_number)]
              : [];

          await ik("/order/action", {
            order_id: Number(job.itemku_order_id),
            action: "DELIVER",
            delivery_info: deliveryInfo
          });

          await db().query(
            `UPDATE order_jobs
             SET state = 'completed',
                 itemku_status = 'DELIVERED',
                 last_error = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [job.id]
          );

          output.push({
            id: job.itemku_order_id,
            state: "completed"
          });
        } else if (
          status === "failed" ||
          status === "refunded"
        ) {
          await db().query(
            `UPDATE order_jobs
             SET state = 'supplier_failed',
                 last_error = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [
              data.fulfillment?.failure_reason ||
                "Supplier " + status,
              job.id
            ]
          );

          output.push({
            id: job.itemku_order_id,
            state: "supplier_failed"
          });
        }
      }
    } catch (error) {
      await db().query(
        `UPDATE order_jobs
         SET last_error = $1,
             attempts = attempts + 1,
             updated_at = NOW()
         WHERE itemku_order_id = $2`,
        [
          String(error.message).slice(0, 900),
          job.itemku_order_id
        ]
      ).catch(() => {});

      await log(
        "error",
        "worker_error",
        error.message,
        { itemku_order_id: job.itemku_order_id }
      );

      output.push({
        id: job.itemku_order_id,
        error: error.message
      });
    }
  }

  return output;
}

module.exports = async (req, res) => {
  const path =
    new URL(req.url, "https://local").pathname
      .replace(/^\/api/, "") || "/";

  try {
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, {
        success: true,
        database_configured: !!process.env.DATABASE_URL,
        itemku_configured: !!(
          process.env.ITEMKU_API_KEY &&
          process.env.ITEMKU_SECRET_KEY
        ),
        ffz_configured: !!(
          process.env.FFZ_GATEWAY_URL &&
          process.env.FFZ_GATEWAY_TOKEN
        )
      });
    }

    if (
      req.method === "POST" &&
      path === "/itemku-callback"
    ) {
      const order =
        req.body?.data?.[0] || req.body || {};

      const id = order.order_id;

      if (!id) {
        return send(res, 400, {
          success: false,
          message: "order_id tidak ada"
        });
      }

      if (
        process.env.ITEMKU_SHOP_ID &&
        !equal(
          req.headers["x-itemku"],
          process.env.ITEMKU_SHOP_ID
        )
      ) {
        return send(res, 401, {
          success: false,
          message: "X-itemku tidak cocok"
        });
      }

      const verified = await itemOrders(id);
      const job = await queueOrder(verified);

      return send(res, 200, {
        success: true,
        accepted: true,
        order_id: id,
        state: job.state
      });
    }

    if (
      req.method === "POST" &&
      path === "/ffz-callback"
    ) {
      await log(
        "info",
        "ffz_callback",
        "Callback FFZ diterima; cron akan verifikasi status.",
        {}
      );

      return send(res, 200, { success: true });
    }

    if (req.method === "GET" && path === "/cron") {
      const supplied =
        (req.headers.authorization || "")
          .replace(/^Bearer\s+/i, "") ||
        new URL(req.url, "https://local")
          .searchParams.get("secret") ||
        "";

      const expected =
        process.env.CRON_SECRET ||
        process.env.APP_SECRET;

      if (!expected || !equal(supplied, expected)) {
        return send(res, 401, {
          success: false,
          message: "Unauthorized cron"
        });
      }

      const results = await worker();

      return send(res, 200, {
        success: true,
        processed: results.length,
        results
      });
    }

    if (!auth(req)) {
      return send(res, 401, {
        success: false,
        message: "Masukkan APP_SECRET melalui prompt dashboard."
      });
    }

    if (
      req.method === "GET" &&
      path === "/check-ip"
    ) {
      const response = await fetch(
        "https://api.ipify.org?format=json",
        { cache: "no-store" }
      );

      if (!response.ok) {
        return send(res, 502, {
          success: false,
          message: "Gagal memeriksa IP keluar"
        });
      }

      const data = await response.json();

      return send(res, 200, {
        success: true,
        outbound_ip: data.ip,
        note: "IP Vercel; bukan jaminan IP keluar FFZ"
      });
    }

    if (req.method === "GET" && path === "/status") {
      const mappings = await db().query(
        `SELECT COUNT(*)::int total,
                COUNT(*) FILTER (WHERE enabled)::int enabled
         FROM product_mappings`
      );

      const jobs = await db().query(
        `SELECT state, COUNT(*)::int total
         FROM order_jobs
         GROUP BY state`
      );

      return send(res, 200, {
        success: true,
        mappings: mappings.rows[0],
        jobs: jobs.rows
      });
    }

    if (
      req.method === "GET" &&
      path === "/itemku/products"
    ) {
      return send(res, 200, {
        success: true,
        data: await products()
      });
    }

    if (
      req.method === "POST" &&
      path === "/sync/itemku"
    ) {
      const rows = await products();

      for (const product of rows) {
        await db().query(
          `INSERT INTO product_mappings
           (
             itemku_product_id,
             itemku_product_name,
             itemku_game_name,
             itemku_price
           )
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (itemku_product_id)
           DO UPDATE SET
             itemku_product_name = EXCLUDED.itemku_product_name,
             itemku_game_name = EXCLUDED.itemku_game_name,
             itemku_price = EXCLUDED.itemku_price,
             updated_at = NOW()`,
          [
            product.id,
            product.name,
            product.game_name || null,
            Number(product.price || 0)
          ]
        );
      }

      await log(
        "info",
        "sync_itemku",
        `Sinkron ${rows.length} produk`,
        {}
      );

      return send(res, 200, {
        success: true,
        synced: rows.length
      });
    }

    if (
      req.method === "GET" &&
      path === "/ffz/products"
    ) {
      return send(res, 200, await ffz("/products/all"));
    }

    if (
      req.method === "GET" &&
      path === "/ffz/account"
    ) {
      return send(res, 200, await ffz("/account/me"));
    }

    if (
      req.method === "GET" &&
      path === "/mappings"
    ) {
      const result = await db().query(
        `SELECT * FROM product_mappings
         ORDER BY itemku_game_name, itemku_product_name`
      );

      return send(res, 200, {
        success: true,
        data: result.rows
      });
    }

    if (
      req.method === "POST" &&
      path === "/mappings"
    ) {
      const body = req.body || {};

      if (
        !body.itemku_product_id ||
        !body.supplier_sku
      ) {
        return send(res, 400, {
          success: false,
          message:
            "itemku_product_id dan supplier_sku wajib"
        });
      }

      
const response = await ffz("/products/all");

const categories =
  response.data?.categories ||
  response.categories ||
  [];

const supplierProducts = categories.flatMap(
  (entry) => {
    const categoryInfo = entry.category || entry;

    const items = Array.isArray(entry.items)
      ? entry.items
      : Array.isArray(entry.products)
        ? entry.products
        : [];

    return items.map((product) => ({
      ...product,
      cat:
        categoryInfo.name ||
        entry.name ||
        entry.category_name ||
        null
    }));
  }
);

const supplierProduct = supplierProducts.find(
  (product) =>
    String(
      product.sku ??
      product.product_sku ??
      product.code ??
      ""
    ).toLowerCase() ===
    String(body.supplier_sku).toLowerCase()
);
      if (!supplierProduct) {
        return send(res, 404, {
          success: false,
          message: "SKU supplier tidak ditemukan"
        });
      }

      const result = await db().query(
        `UPDATE product_mappings
         SET supplier_sku = $1,
             supplier_product_name = $2,
             supplier_category = $3,
             supplier_price = $4,
             updated_at = NOW()
         WHERE itemku_product_id = $5
         RETURNING *`,
        [
          supplierProduct.sku,
          supplierProduct.name,
          supplierProduct.cat ||
            supplierProduct.category ||
            null,
          Number(
            supplierProduct.price ??
            supplierProduct.amount ??
            0
          ),
          Number(body.itemku_product_id)
        ]
      );

      if (!result.rows[0]) {
        return send(res, 404, {
          success: false,
          message: "Sinkronkan produk Itemku dahulu"
        });
      }

      return send(res, 200, {
        success: true,
        data: result.rows[0]
      });
    }

    if (req.method === "GET" && path === "/orders") {
      const result = await db().query(
        `SELECT * FROM order_jobs
         ORDER BY created_at DESC
         LIMIT 100`
      );

      return send(res, 200, {
        success: true,
        data: result.rows
      });
    }

    if (
      req.method === "POST" &&
      path === "/orders/poll"
    ) {
      return send(res, 200, {
        success: true,
        results: await worker()
      });
    }

    if (req.method === "GET" && path === "/logs") {
      const result = await db().query(
        `SELECT * FROM system_logs
         ORDER BY created_at DESC
         LIMIT 100`
      );

      return send(res, 200, {
        success: true,
        data: result.rows
      });
    }

    return send(res, 404, {
      success: false,
      message: "Endpoint tidak ditemukan"
    });
  } catch (error) {
    console.error(error);

    await log(
      "error",
      "api_error",
      error.message,
      { path }
    );

    return send(res, error.status || 500, {
      success: false,
      message: error.message,
      details: error.details
    });
  }
};
