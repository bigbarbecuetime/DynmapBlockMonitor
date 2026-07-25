/* ============================================================================
   csv.js -- CSV reading, and the incremental tailer that live mode runs on.
   ----------------------------------------------------------------------------
   Classic script (not an ES module) on purpose: modules are blocked by the
   file:// origin rules, and dropping the two CSVs onto a page opened straight
   from disk is the zero-setup path we want to keep working.
   ========================================================================= */

window.DV = window.DV || {};

(function (DV) {
  "use strict";

  /* Full RFC4180-ish parse: quoted fields, "" escapes, embedded newlines, CRLF,
     and a UTF-8 BOM. Player names are server-supplied, so we never assume a row
     is comma-safe. */
  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = parseRows(text);
    if (!rows.length) return { fields: [], rows: [] };
    var fields = rows[0];
    return { fields: fields, rows: toObjects(fields, rows.slice(1)) };
  }

  /* Same, for a chunk appended after the header was already read. */
  function parseBody(text, fields) {
    return toObjects(fields, parseRows(text));
  }

  function toObjects(fields, arrays) {
    var out = [];
    for (var i = 0; i < arrays.length; i++) {
      var a = arrays[i];
      // A row that is just the header again means the tracker restarted onto an
      // empty file, or we tailed across a rotation -- skip it, don't parse it as
      // data (it would otherwise show up as a player literally named "player").
      if (a.length === fields.length && a[0] === fields[0] && a[1] === fields[1]) continue;
      var o = {};
      for (var j = 0; j < fields.length; j++) o[fields[j]] = j < a.length ? a[j] : "";
      out.push(o);
    }
    return out;
  }

  function parseRows(text) {
    var rows = [], row = [], field = "", i = 0, quoted = false, n = text.length;
    while (i < n) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); field = ""; pushRow(rows, row); row = []; i++; continue; }
      field += c; i++;
    }
    if (field !== "" || row.length) { row.push(field); pushRow(rows, row); }
    return rows;
  }

  function pushRow(rows, row) {
    if (row.length === 1 && row[0] === "") return; // blank line
    rows.push(row);
  }

  /* ------------------------------------------------------------------ tailer */

  /* A Tailer follows one growing CSV over HTTP. The tracker only ever appends,
     so we ask for the bytes past what we already hold with a Range request and
     parse just those -- a 1 MB chunks.csv is not re-downloaded every few
     seconds. Servers that ignore Range answer 200 with the whole body, which we
     detect and fall back to a full re-parse, so this degrades instead of
     breaking. */
  function Tailer(url) {
    this.url = url;
    /* Whether the server honours Range (null = not yet known). This describes the
       SERVER, not our read position, so reset() must not clear it -- doing so made
       the "false" state unreachable, because every re-read path runs through
       reset() and the next poll then looks like a first poll. */
    this.ranged = null;
    this.reset();
  }

  Tailer.prototype.reset = function () {
    this.bytes = 0;        // total bytes consumed from the file so far
    this.fields = null;
    this.pending = new Uint8Array(0); // trailing partial line, held for next poll
  };

  /* Resolves to {rows, fields, reset, total} -- reset:true means the caller
     should throw away previously parsed rows because the file was replaced. */
  Tailer.prototype.poll = function () {
    var self = this;
    var headers = {};
    var first = this.bytes === 0;
    if (!first) headers.Range = "bytes=" + this.bytes + "-";

    return fetch(this.url, { headers: headers, cache: "no-store" }).then(function (res) {
      // 416 = we asked past EOF. Either nothing new (common) or the file shrank
      // (rotated/truncated), which Content-Range's total tells us apart.
      if (res.status === 416) {
        var total = totalFromRange(res.headers.get("Content-Range"));
        if (total !== null && total < self.bytes) { self.reset(); return self.poll(); }
        return { rows: [], fields: self.fields, reset: false, total: self.bytes };
      }
      if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);

      var isPartial = res.status === 206;
      if (!first && !isPartial) {
        // Server ignored Range and sent everything: re-parse from scratch, and
        // remember that this server cannot be tailed so the UI can say so.
        self.reset();
        self.ranged = false;
        return res.arrayBuffer().then(function (buf) { return self._consume(buf, true); });
      }
      if (!first && isPartial) {
        var total = totalFromRange(res.headers.get("Content-Range"));
        if (total !== null && total < self.bytes) { self.reset(); return self.poll(); }
      }
      // Only a poll that actually SENT a Range header tells us anything about
      // support; the first poll deliberately sends none, so it stays "unknown".
      if (!first) self.ranged = isPartial;
      return res.arrayBuffer().then(function (buf) { return self._consume(buf, first); });
    });
  };

  Tailer.prototype._consume = function (buf, isFull) {
    var incoming = new Uint8Array(buf);
    this.bytes += incoming.length;

    // Stitch the partial line held back last time onto the front.
    var joined;
    if (this.pending.length) {
      joined = new Uint8Array(this.pending.length + incoming.length);
      joined.set(this.pending, 0);
      joined.set(incoming, this.pending.length);
    } else {
      joined = incoming;
    }

    // Only parse up to the last newline; a half-written final row is normal when
    // we poll while the tracker is mid-append.
    var cut = lastNewline(joined);
    if (cut < 0) { this.pending = joined; return { rows: [], fields: this.fields, reset: isFull, total: this.bytes }; }
    this.pending = joined.slice(cut + 1);

    var text = new TextDecoder("utf-8").decode(joined.subarray(0, cut + 1));
    var rows;
    if (isFull || !this.fields) {
      var p = parse(text);
      this.fields = p.fields;
      rows = p.rows;
    } else {
      rows = parseBody(text, this.fields);
    }
    return { rows: rows, fields: this.fields, reset: isFull, total: this.bytes };
  };

  function lastNewline(u8) {
    for (var i = u8.length - 1; i >= 0; i--) if (u8[i] === 10) return i;
    return -1;
  }

  function totalFromRange(h) {
    if (!h) return null;
    var m = /\/(\d+)\s*$/.exec(h);
    return m ? parseInt(m[1], 10) : null;
  }

  DV.csv = { parse: parse, parseBody: parseBody, Tailer: Tailer };
})(window.DV);
