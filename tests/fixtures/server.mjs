// A small multi-page site used by the e2e tests. Pure Node, no dependencies.
import http from "node:http";

const PRODUCTS = [
  { slug: "blue-widget", name: "Blue Widget", price: 12, blurb: "A dependable blue widget for everyday tasks." },
  { slug: "red-gadget", name: "Red Gadget", price: 25, blurb: "A fast red gadget with a two-year warranty." },
  { slug: "green-gizmo", name: "Green Gizmo", price: 8, blurb: "An eco-friendly green gizmo." },
  { slug: "yellow-doohickey", name: "Yellow Doohickey", price: 41, blurb: "A premium yellow doohickey." },
];
const PLANS = [
  { id: "starter", name: "Starter", price: "$0" },
  { id: "team", name: "Team", price: "$29" },
  { id: "business", name: "Business", price: "$99" },
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout(title, body, { user } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Widgetry</title>
<style>body{font-family:system-ui;margin:0}header{background:#123;color:#fff;padding:12px 20px}header a{color:#fff;margin-right:16px}main{padding:20px;max-width:900px}.card{border:1px solid #ddd;padding:12px;margin:8px 0}footer{padding:20px;color:#666}</style></head>
<body><header><a href="/">Home</a><a href="/products">Products</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/contact">Contact</a>${user ? `<span>Signed in as ${esc(user)}</span> <a href="/logout">Sign out</a>` : `<a href="/login">Sign in</a>`}
<form action="/search" method="get" style="display:inline;margin-left:20px"><label for="q">Search</label> <input id="q" name="q" placeholder="Search products"><button type="submit">Go</button></form></header>
<main>${body}</main><footer>© Widgetry Inc.</footer></body></html>`;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter(([k]) => k));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data))));
  });
}

export function createSite() {
  const events = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const cookies = parseCookies(req);
    const user = cookies.user ? decodeURIComponent(cookies.user) : null;
    const send = (html, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(html);
    };
    const p = url.pathname;
    events.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams) });

    if (p === "/") return send(layout("Home", `<h1>Welcome to Widgetry</h1><p>We sell widgets, gadgets and gizmos.</p><p><a href="/products">Browse the catalog</a> or <a href="/pricing">see pricing</a>.</p><div class="card"><h2>News</h2><p>Nothing new today.</p></div>`, { user }));
    if (p === "/products") return send(layout("Products", `<h1>Products</h1>${PRODUCTS.map((x) => `<div class="card"><h2><a href="/products/${x.slug}">${x.name}</a></h2><p>${x.blurb}</p><p>$${x.price}</p></div>`).join("")}`, { user }));
    const prod = PRODUCTS.find((x) => p === `/products/${x.slug}`);
    if (prod) return send(layout(prod.name, `<h1>${prod.name}</h1><p>${prod.blurb}</p><p>Price: $${prod.price}</p><form method="post" action="/cart/add"><input type="hidden" name="slug" value="${prod.slug}"><label>Quantity <select name="qty"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label> <button type="submit">Add to cart</button></form>`, { user }));
    if (p === "/cart/add" && req.method === "POST") {
      const body = await readBody(req);
      const item = PRODUCTS.find((x) => x.slug === body.slug);
      return send(layout("Cart", `<h1>Cart</h1><p class="notice">Added ${body.qty} × ${item?.name ?? body.slug} to your cart.</p><a href="/products">Continue shopping</a>`, { user }));
    }
    if (p === "/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = PRODUCTS.filter((x) => x.name.toLowerCase().includes(q) || x.blurb.toLowerCase().includes(q));
      return send(layout("Search", `<h1>Search results for “${esc(q)}”</h1>${hits.length ? hits.map((x) => `<div class="card"><a href="/products/${x.slug}">${x.name}</a> — ${x.blurb}</div>`).join("") : "<p>No products match.</p>"}`, { user }));
    }
    if (p === "/pricing") return send(layout("Pricing", `<h1>Pricing</h1>${PLANS.map((pl) => `<div class="card"><h2>${pl.name}</h2><p>${pl.price} per month</p><form method="post" action="/trial"><input type="hidden" name="plan" value="${pl.id}"><button type="submit">Start free trial</button></form></div>`).join("")}`, { user }));
    if (p === "/trial" && req.method === "POST") {
      const body = await readBody(req);
      const plan = PLANS.find((x) => x.id === body.plan);
      return send(layout("Trial started", `<h1>Your ${plan?.name ?? body.plan} trial has started</h1><p>Enjoy 14 days of the ${plan?.name} plan.</p>`, { user }));
    }
    if (p === "/docs") return send(layout("Docs", `<h1>Documentation</h1><p>Read the guides below.</p><div style="height:1800px"></div><h2 id="advanced">Advanced settings</h2><p>Deep in the page.</p><button id="reveal" onclick="document.getElementById('secret').hidden=false">Show the secret code</button><p id="secret" hidden>The secret code is 4711.</p>`, { user }));
    if (p === "/login" && req.method === "GET") return send(layout("Sign in", `<h1>Sign in</h1>${url.searchParams.get("error") ? "<p class='error'>Invalid credentials.</p>" : ""}<form method="post" action="/login"><p><label for="email">Email</label> <input id="email" type="email" name="email" required></p><p><label for="password">Password</label> <input id="password" type="password" name="password" required></p><button type="submit">Sign in</button></form>`));
    if (p === "/login" && req.method === "POST") {
      const body = await readBody(req);
      if (body.password === "hunter2") {
        res.writeHead(302, { location: "/dashboard", "set-cookie": `user=${encodeURIComponent(body.email)}; Path=/` });
        return res.end();
      }
      res.writeHead(302, { location: "/login?error=1" });
      return res.end();
    }
    if (p === "/logout") {
      res.writeHead(302, { location: "/", "set-cookie": "user=; Path=/; Max-Age=0" });
      return res.end();
    }
    if (p === "/dashboard") {
      if (!user) return send(layout("Sign in required", `<h1>Please sign in</h1><p>You must be signed in to view the dashboard.</p><a href="/login">Go to sign in</a>`), 401);
      return send(layout("Dashboard", `<h1>Welcome, ${esc(user)}</h1><p>This is your dashboard.</p>`, { user }));
    }
    if (p === "/admin") return send(layout("Restricted", `<h1>Restricted area</h1><p>Administrator access is required. Please contact your administrator to request access; there is no self-service sign-in for this area.</p>`), 403);
    if (p === "/contact" && req.method === "GET") return send(layout("Contact", `<h1>Contact us</h1><form method="post" action="/contact"><p><label for="name">Your name</label> <input id="name" name="name" required></p><p><label for="cemail">Email address</label> <input id="cemail" type="email" name="email" required></p><p><label for="topic">Topic</label> <select id="topic" name="topic"><option value="">Choose…</option><option value="sales">Sales question</option><option value="billing">Billing problem</option><option value="support">Technical support</option></select></p><p><label for="message">Message</label> <textarea id="message" name="message" required></textarea></p><button type="submit">Send message</button></form>`, { user }));
    if (p === "/contact" && req.method === "POST") {
      const body = await readBody(req);
      return send(layout("Thanks", `<h1>Thanks, ${esc(body.name)}!</h1><p>Your ${esc(body.topic || "general")} message was received. We will reply to ${esc(body.email)}.</p>`, { user }));
    }
    if (p === "/consent") return send(layout("Consent", `<div role="dialog" aria-label="Cookie consent" style="position:fixed;inset:0;background:rgba(0,0,0,.6);color:#fff;padding:40px"><h2>We use cookies</h2><p>Accept to continue.</p><button onclick="this.closest('[role=dialog]').remove()">Accept all</button></div><h1>Blog</h1><p>Latest article: Widgets in 2026.</p><a href="/products">Products</a>`, { user }));
    return send(layout("Not found", `<h1>Page not found</h1><p>The page ${esc(p)} does not exist.</p>`), 404);
  });
  return {
    server,
    events,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      this.baseUrl = `http://127.0.0.1:${port}`;
      return this.baseUrl;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = createSite();
  const url = await site.listen();
  console.log(`fixture site at ${url}`);
}
