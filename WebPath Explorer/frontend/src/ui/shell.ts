export const icons = {
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 6v5h-5"/><path d="M19 11a7.5 7.5 0 1 0 .2 4"/></svg>',
  compass:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9 4.9-2.1Z"/></svg>',
  gpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  external:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 5h5v5M12 12l7-7"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  branch:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 5h2a4 4 0 0 1 4 4v5a4 4 0 0 0 4 4M14 10a4 4 0 0 1 4-2"/></svg>',
};

export function shell(): string {
  return `
    <main class="app-shell">
      <canvas id="graph-canvas" aria-label="Interactive website relationship graph" tabindex="0"></canvas>
      <div class="ambient-grid"></div>

      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true"></div>
          <div class="brand-copy">
            <strong>WebPath Explorer</strong>
            <span>Persistent research graph</span>
          </div>
        </div>
        <form class="global-search" id="graph-search-form" role="search">
          ${icons.search}
          <input id="graph-search" type="search" autocomplete="off" placeholder="Find a URL, domain, topic or agent…" aria-label="Search graph" />
          <kbd>/</kbd>
        </form>
        <div class="top-actions">
          <div class="view-mode-toggle" role="group" aria-label="Graph dimension">
            <button type="button" class="is-active" data-view-mode="2d" aria-pressed="true">2D</button>
            <button type="button" data-view-mode="3d" aria-pressed="false">3D</button>
          </div>
          <div class="live-crawls">
            <button class="live-pill" id="live-pill" type="button" aria-expanded="false" aria-controls="crawl-drawer" aria-haspopup="true">
              <span class="live-dot" aria-hidden="true"></span>
              <span id="live-text">Live graph</span>
              <svg class="live-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>
            </button>
            <section class="crawl-drawer" id="crawl-drawer" aria-labelledby="crawl-drawer-title" hidden>
              <div class="crawl-drawer-head">
                <div>
                  <p class="eyebrow">Live activity</p>
                  <h2 id="crawl-drawer-title">Crawl monitor</h2>
                </div>
                <span class="crawl-connection" id="crawl-connection">Connecting</span>
              </div>
              <div class="crawl-section">
                <div class="crawl-section-head">
                  <h3>Active</h3>
                  <span id="crawl-running-count">0</span>
                </div>
                <div class="crawl-activity-list" id="crawl-running-list" aria-live="polite"></div>
                <p class="crawl-empty" id="crawl-empty">No crawls are running.</p>
              </div>
              <div class="crawl-section" id="crawl-recent-section" hidden>
                <div class="crawl-section-head">
                  <h3>Recent</h3>
                </div>
                <div class="crawl-activity-list" id="crawl-recent-list"></div>
              </div>
            </section>
          </div>
          <button class="icon-button" id="fit-button" type="button" aria-label="Fit graph to viewport" title="Fit graph (F)">${icons.fit}</button>
          <button class="icon-button" id="reload-button" type="button" aria-label="Reload graph" title="Reload graph">${icons.refresh}</button>
        </div>
      </header>

      <aside class="side-panel" aria-label="Graph controls">
        <section class="panel-section">
          <p class="eyebrow">Start an expedition</p>
          <h2 class="crawl-title">Crawl a path</h2>
            <p class="section-copy">Launch as many paths as you like. They crawl concurrently and stream into the permanent graph.</p>
          <form id="crawl-form">
            <div class="field-row">
              <label class="field">
                <span>Starting URL</span>
                <input id="crawl-url" type="url" inputmode="url" placeholder="https://example.com" required />
              </label>
              <label class="field">
                <span>Depth</span>
                <input id="crawl-depth" type="number" min="1" max="10" step="1" value="2" required />
              </label>
            </div>
            <button class="primary-button" id="crawl-button" type="submit">${icons.compass}<span>Launch crawl</span></button>
          </form>
        </section>

        <section class="panel-section">
          <p class="eyebrow">Graph overview</p>
          <div class="stats-grid">
            <div class="stat"><strong id="stat-nodes">—</strong><span>Nodes</span></div>
            <div class="stat"><strong id="stat-edges">—</strong><span>Connections</span></div>
            <div class="stat"><strong id="stat-domains">—</strong><span>Domains</span></div>
            <div class="stat"><strong id="stat-searches">—</strong><span>Searches</span></div>
          </div>
          <p class="visible-note"><span id="visible-nodes">0</span> visible · <span id="visible-edges">0</span> linked</p>
        </section>

        <section class="panel-section">
          <p class="eyebrow">Shape the view</p>
          <label class="field">
            <span>Domain</span>
            <select id="domain-filter"><option value="">All domains</option></select>
          </label>
          <label class="field">
            <span>Entity type</span>
            <select id="kind-filter"><option value="">All entity types</option></select>
          </label>
          <label class="toggle-label">
            <span>Research origins only</span>
            <input id="originals-filter" type="checkbox" />
            <span class="toggle" aria-hidden="true"></span>
          </label>
          <label class="toggle-label">
            <span>Hide unlinked nodes</span>
            <input id="isolated-filter" type="checkbox" />
            <span class="toggle" aria-hidden="true"></span>
          </label>
          <label class="field">
            <span>Node scale</span>
            <span class="range-wrap">
              <input id="node-scale" type="range" min="0.45" max="2.5" step="0.05" value="1" />
              <span class="range-value" id="node-scale-value">1.00×</span>
            </span>
          </label>
          <label class="field">
            <span>Connection intensity</span>
            <span class="range-wrap">
              <input id="edge-alpha" type="range" min="0.02" max="0.5" step="0.01" value="0.13" />
              <span class="range-value" id="edge-alpha-value">13%</span>
            </span>
          </label>
        </section>

        <section class="panel-section">
          <button class="danger-button" id="clear-button" type="button">Clear graph database</button>
        </section>
      </aside>

      <aside class="details-panel" id="details-panel" aria-label="Selected node" hidden>
        <div class="details-head">
          <div>
            <span class="node-kind" id="detail-kind">Page</span>
            <h2 class="node-title" id="detail-title"></h2>
            <span class="node-url" id="detail-url"></span>
          </div>
          <button class="icon-button" id="details-close" type="button" aria-label="Close details">${icons.close}</button>
        </div>
        <div class="detail-body">
          <div class="detail-actions">
            <button class="text-button" id="detail-open" type="button">${icons.external} Open page</button>
            <button class="text-button" id="detail-copy" type="button">${icons.copy} Copy URL</button>
            <button class="text-button" id="detail-crawl" type="button">${icons.compass} Crawl here</button>
            <button class="text-button" id="detail-neighbors" type="button">${icons.branch} Neighbors</button>
          </div>
          <dl class="meta-list" id="detail-meta"></dl>
          <div class="connection-group" id="outgoing-group">
            <div class="connection-head"><h3>Links from this page</h3><span id="outgoing-count"></span></div>
            <ul class="connection-list" id="outgoing-list"></ul>
          </div>
          <div class="connection-group" id="incoming-group">
            <div class="connection-head"><h3>Links to this page</h3><span id="incoming-count"></span></div>
            <ul class="connection-list" id="incoming-list"></ul>
          </div>
        </div>
      </aside>

      <div class="tooltip" id="tooltip" role="tooltip" hidden>
        <strong id="tooltip-title"></strong>
        <span id="tooltip-meta"></span>
      </div>

      <menu class="context-menu" id="context-menu" hidden>
        <button type="button" data-action="open">${icons.external} Open website</button>
        <button type="button" data-action="copy">${icons.copy} Copy URL</button>
        <button type="button" data-action="crawl">${icons.compass} Crawl from here</button>
        <div class="context-separator"></div>
        <button type="button" data-action="neighbors">${icons.branch} Isolate neighborhood</button>
      </menu>

      <footer class="statusbar">
        <div>
          <span class="status-accent" id="status-message">Waiting for graph</span>
          <span id="zoom-status">100%</span>
          <span id="gpu-memory">0 MB GPU buffers</span>
        </div>
        <div>
          <span id="primary-gesture">Drag to pan</span><span id="secondary-gesture">Scroll to zoom</span><span>Right-click for actions</span>
        </div>
      </footer>

      <div class="toast-stack" id="toast-stack" aria-live="polite"></div>

    </main>
  `;
}
