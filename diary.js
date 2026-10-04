// ─────────────────────────────────────────────────────────────────────
// DIARY · the lock, and the diary behind it
//
// The page arrives holding nothing readable. The passphrase typed here is
// turned into a key (PBKDF2, SHA-256), and that key opens the sealed bundle
// of entries (AES-GCM). A wrong passphrase makes a key that opens nothing.
// The key (never the passphrase) is kept in this tab until it closes, or
// until the circumpunct at the foot is pressed to lock the diary again.
//
// Addresses: /#/ (the newest page), /#/page/2, /#/p/<entry>
// ─────────────────────────────────────────────────────────────────────
;(() => {
  const LOCK = JSON.parse(document.getElementById("lock").textContent)
  const KEPT = "diary-key"
  const subtle = crypto.subtle
  const $ = (id) => document.getElementById(id)
  const gate = $("gate"), field = $("password"), wrong = $("wrong")
  const main = $("main"), foot = $("foot"), pager = $("pager"), search = $("search")

  const b64 = {
    from: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
    to: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  }

  // ── The lock ──────────────────────────────────────────────────────

  async function keyFrom(passphrase) {
    const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"])
    return subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: b64.from(LOCK.salt), iterations: LOCK.iterations },
      base, { name: "AES-GCM", length: 256 }, true, ["decrypt"],
    )
  }

  async function open(key, buf) {
    const bytes = new Uint8Array(buf)
    return subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12))
  }

  // start fetching the sealed bundle while the passphrase is being typed
  let sealed = null
  const fetchVault = () =>
    (sealed ??= fetch(LOCK.vault).then((r) => {
      if (!r.ok) throw new Error("vault")
      return r.arrayBuffer()
    }).catch((e) => ((sealed = null), Promise.reject(e))))

  let diary = null
  let key = null

  async function unlock(k) {
    const plain = await open(k, await fetchVault())
    diary = JSON.parse(new TextDecoder().decode(plain))
    diary.entries.forEach((e) => (e.date = new Date(e.date)))
    key = k
    return true
  }

  function keep(k) {
    subtle.exportKey("raw", k).then((raw) => {
      try { sessionStorage.setItem(KEPT, JSON.stringify({ salt: LOCK.salt, key: b64.to(raw) })) } catch {}
    })
  }

  async function kept() {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEPT) || "null")
      if (!s || s.salt !== LOCK.salt) return null
      return await subtle.importKey("raw", b64.from(s.key), { name: "AES-GCM" }, true, ["decrypt"])
    } catch {
      return null
    }
  }

  function fail(text) {
    gate.classList.remove("shake")
    void gate.offsetWidth // restart the shake
    wrong.textContent = text
    gate.classList.add("shake", "failed")
    field.select()
  }

  let trying = false
  gate.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (trying || !field.value) return
    trying = true
    gate.classList.add("trying")
    try {
      const k = await keyFrom(field.value)
      try {
        await unlock(k)
      } catch (err) {
        if (err instanceof Error && err.message === "vault") throw err
        fail("not that word. try again.")
        return
      }
      keep(k)
      field.value = ""
      enter()
    } catch {
      fail("the diary couldn't be reached. try again in a moment.")
    } finally {
      trying = false
      gate.classList.remove("trying")
    }
  })
  field.addEventListener("input", () => gate.classList.remove("failed"))
  field.addEventListener("focus", () => fetchVault().catch(() => {}), { once: true })

  $("lockup").addEventListener("click", () => {
    try { sessionStorage.removeItem(KEPT) } catch {}
    location.replace("/")
  })

  // ── The diary ────────────────────────────────────────────────────

  const fmt = (d, opts, locale = "en-US") => new Intl.DateTimeFormat(locale, { timeZone: LOCK.timeZone, ...opts }).format(d)
  const timeOf = (d) => fmt(d, { hour: "numeric", minute: "2-digit" }).replace(/\s+/g, " ").toLowerCase()
  const dayKey = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" })
  const yearOf = (d) => fmt(d, { year: "numeric" })
  function dayLabel(d, withYear) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone: LOCK.timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" })
        .formatToParts(d).map((x) => [x.type, x.value]),
    )
    return `${p.weekday}<span class="date">${p.day} ${p.month}${withYear ? ` ${p.year}` : ""}</span>`
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

  // the year shows only on days from a year other than the newest entry's
  const withYear = (d) => diary.entries.length && yearOf(d) !== yearOf(diary.entries[0].date)

  function entryHtml(e, { linked = true, body = e.html } = {}) {
    const time = `<time datetime="${e.date.toISOString()}">${timeOf(e.date)}</time>`
    return `<article class="post" id="${e.slug}"><div class="body">${body}</div>${
      linked ? `<a class="when" href="#/p/${e.slug}">${time}</a>` : `<p class="when">${time}</p>`
    }</article>`
  }

  function byDay(entries) {
    const days = []
    for (const e of entries) {
      const last = days[days.length - 1]
      if (last && dayKey(last[0].date) === dayKey(e.date)) last.push(e)
      else days.push([e])
    }
    return days
  }

  function daysHtml(entries, opts = {}) {
    return byDay(entries).map((d) =>
      `<section class="day"><h2 class="dayname">${dayLabel(d[0].date, opts.alwaysYear || withYear(d[0].date))}</h2>${
        d.map((e) => entryHtml(e, { linked: opts.linked ?? true, body: opts.body ? opts.body(e) : e.html })).join("")
      }</section>`).join("")
  }

  function route() {
    const h = location.hash.replace(/^#\/?/, "")
    const one = h.match(/^p\/(.+)$/)
    const n = +(h.match(/^page\/(\d+)$/)?.[1] ?? 1)
    search.value = ""
    document.body.classList.remove("single")
    if (one) {
      const e = diary.entries.find((x) => x.slug === decodeURIComponent(one[1]))
      if (e) {
        document.body.classList.add("single")
        main.innerHTML = daysHtml([e], { alwaysYear: true, linked: false }) + `<p class="back"><a href="#/">All entries</a></p>`
        pager.innerHTML = ""
        return reveal()
      }
    }
    const pages = Math.max(1, Math.ceil(diary.entries.length / LOCK.perPage))
    const page = Math.min(Math.max(1, n), pages)
    const list = diary.entries.slice((page - 1) * LOCK.perPage, page * LOCK.perPage)
    main.innerHTML = list.length ? daysHtml(list) : `<p class="empty">Nothing written yet.</p>`
    const url = (k) => (k === 1 ? "#/" : `#/page/${k}`)
    pager.innerHTML =
      (page > 1 ? `<a href="${url(page - 1)}" rel="prev">← Newer</a>` : "") +
      (page < pages ? `<a href="${url(page + 1)}" rel="next">Older →</a>` : "")
    reveal()
  }

  // images are sealed too: open each one as it appears
  const images = new Map()
  function reveal() {
    for (const img of main.querySelectorAll("img[data-sealed]")) {
      const src = img.dataset.sealed
      if (!images.has(src)) {
        images.set(src, fetch(src).then((r) => r.arrayBuffer()).then((b) => open(key, b))
          .then((plain) => URL.createObjectURL(new Blob([plain], { type: img.dataset.type }))))
      }
      images.get(src).then((u) => (img.src = u)).catch(() => images.delete(src))
    }
  }

  // ── Search, across every entry ───────────────────────────────────

  function tint(html, q) {
    const t = document.createElement("template")
    t.innerHTML = html
    const walk = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT)
    const texts = []
    while (walk.nextNode()) texts.push(walk.currentNode)
    const needle = q.toLowerCase()
    for (const node of texts) {
      const s = node.nodeValue, low = s.toLowerCase()
      let i = low.indexOf(needle)
      if (i < 0) continue
      const frag = document.createDocumentFragment()
      let last = 0
      while (i >= 0) {
        frag.append(s.slice(last, i))
        const mark = document.createElement("mark")
        mark.className = "hit"
        mark.textContent = s.slice(i, i + needle.length)
        frag.append(mark)
        last = i + needle.length
        i = low.indexOf(needle, last)
      }
      frag.append(s.slice(last))
      node.replaceWith(frag)
    }
    return t.innerHTML
  }

  search.addEventListener("input", () => {
    const q = search.value.trim()
    if (!q) return route()
    const hits = diary.entries.filter((e) => e.text.toLowerCase().includes(q.toLowerCase()))
    document.body.classList.remove("single")
    main.innerHTML = `<p class="found">${
      hits.length ? `${hits.length} entr${hits.length === 1 ? "y" : "ies"} with “${esc(q)}”` : `Nothing with “${esc(q)}”.`
    }</p>` + daysHtml(hits, { body: (e) => tint(e.html, q) })
    pager.innerHTML = `<a href="#/">All entries</a>`
    reveal()
  })
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { search.value = ""; route() }
  })

  // ── Opening ──────────────────────────────────────────────────────

  function enter() {
    document.body.classList.remove("locked")
    document.body.classList.add("open")
    main.hidden = foot.hidden = false
    route()
  }

  addEventListener("hashchange", () => {
    if (!diary) return
    route()
    scrollTo(0, 0)
  })

  // already opened in this tab? go straight in
  kept().then(async (k) => {
    if (k) {
      try {
        await unlock(k)
        return enter()
      } catch {
        try { sessionStorage.removeItem(KEPT) } catch {}
      }
    }
    document.body.classList.add("ready")
  })
})()
