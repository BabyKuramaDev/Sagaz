/**
 * The toybox "world": a simulated external environment (CRM, email, tweets, bank)
 * persisted in a SQLite file so tests and demos can inspect it from outside the agent.
 *
 * Domains map deliberately onto the R/C/I taxonomy:
 *   - CRM (contacts)      → R: every mutation has a deterministic inverse.
 *   - Comms (email/tweet) → C: sending cannot be undone; corrections/deletions exist.
 *   - Bank (transfers)    → I: a transfer moves money and the world offers no inverse.
 */
import Database from "better-sqlite3";

export const DEFAULT_DB_PATH = "./toybox.db";

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["TOYBOX_DB"] ?? DEFAULT_DB_PATH;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  company    TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  in_reply_to INTEGER REFERENCES emails(id),
  sent_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tweets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  posted_at  TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0)
);
CREATE TABLE IF NOT EXISTS transfers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account TEXT NOT NULL REFERENCES accounts(id),
  to_account   TEXT NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  memo         TEXT,
  executed_at  TEXT NOT NULL
);
`;

export interface Contact {
  id: number;
  name: string;
  email: string;
  company: string | null;
  created_at: string;
}
export interface Email {
  id: number;
  to_addr: string;
  subject: string;
  body: string;
  in_reply_to: number | null;
  sent_at: string;
}
export interface Tweet {
  id: number;
  text: string;
  posted_at: string;
  deleted_at: string | null;
}
export interface Account {
  id: string;
  owner: string;
  balance_cents: number;
}
export interface Transfer {
  id: number;
  from_account: string;
  to_account: string;
  amount_cents: number;
  memo: string | null;
  executed_at: string;
}

export class WorldError extends Error {
  override readonly name = "WorldError";
}

/** Injectable clock so seeds and tests are deterministic. */
export type Clock = () => string;
const isoNow: Clock = () => new Date().toISOString();

export class World {
  private readonly db: Database.Database;
  private readonly now: Clock;

  constructor(path: string, opts: { clock?: Clock } = {}) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.now = opts.clock ?? isoNow;
  }

  close(): void {
    this.db.close();
  }

  // ---- CRM (type R) --------------------------------------------------------

  listContacts(): Contact[] {
    return this.db.prepare("SELECT * FROM contacts ORDER BY id").all() as Contact[];
  }

  /**
   * `company` accepts null as "no company" so an inverse derived from a pre-state can express it.
   * `id` is the restore semantics (T11): an inverse of `delete_contact` must restore IDENTITY,
   * not just content — pass the original id to recreate the contact as the row it was. Omitted,
   * the world assigns a fresh id as usual. AUTOINCREMENT keeps future ids above any restored one.
   */
  createContact(input: { id?: number | undefined; name: string; email: string; company?: string | null | undefined }): Contact {
    const existing = this.db.prepare("SELECT id FROM contacts WHERE email = ?").get(input.email);
    if (existing) throw new WorldError(`A contact with email ${input.email} already exists`);
    if (input.id !== undefined && this.db.prepare("SELECT id FROM contacts WHERE id = ?").get(input.id)) {
      throw new WorldError(`Contact ${input.id} already exists`);
    }
    const info = this.db
      .prepare("INSERT INTO contacts (id, name, email, company, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.id ?? null, input.name, input.email, input.company ?? null, this.now());
    return this.getContact(Number(info.lastInsertRowid));
  }

  /** `company: null` clears the field (needed so the inverse of an update is expressible). */
  updateContact(
    id: number,
    patch: { name?: string | undefined; email?: string | undefined; company?: string | null | undefined },
  ): Contact {
    const current = this.getContact(id);
    const email = patch.email ?? current.email;
    if (email !== current.email) {
      const clash = this.db.prepare("SELECT id FROM contacts WHERE email = ?").get(email);
      if (clash) throw new WorldError(`A contact with email ${email} already exists`);
    }
    const company = patch.company === undefined ? current.company : patch.company;
    this.db
      .prepare("UPDATE contacts SET name = ?, email = ?, company = ? WHERE id = ?")
      .run(patch.name ?? current.name, email, company, id);
    return this.getContact(id);
  }

  deleteContact(id: number): Contact {
    const contact = this.getContact(id);
    this.db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    return contact;
  }

  getContact(id: number): Contact {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Contact | undefined;
    if (!row) throw new WorldError(`Contact ${id} not found`);
    return row;
  }

  // ---- Comms (type C) ------------------------------------------------------

  sendEmail(input: { to: string; subject: string; body: string; inReplyTo?: number | undefined }): Email {
    if (input.inReplyTo !== undefined) this.getEmail(input.inReplyTo);
    const info = this.db
      .prepare("INSERT INTO emails (to_addr, subject, body, in_reply_to, sent_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.to, input.subject, input.body, input.inReplyTo ?? null, this.now());
    return this.getEmail(Number(info.lastInsertRowid));
  }

  listInbox(): Email[] {
    return this.db.prepare("SELECT * FROM emails ORDER BY id").all() as Email[];
  }

  private getEmail(id: number): Email {
    const row = this.db.prepare("SELECT * FROM emails WHERE id = ?").get(id) as Email | undefined;
    if (!row) throw new WorldError(`Email ${id} not found`);
    return row;
  }

  postTweet(text: string): Tweet {
    if (text.length > 280) throw new WorldError("Tweet exceeds 280 characters");
    const info = this.db.prepare("INSERT INTO tweets (text, posted_at) VALUES (?, ?)").run(text, this.now());
    return this.getTweet(Number(info.lastInsertRowid));
  }

  deleteTweet(id: number): Tweet {
    const tweet = this.getTweet(id);
    if (tweet.deleted_at) throw new WorldError(`Tweet ${id} is already deleted`);
    this.db.prepare("UPDATE tweets SET deleted_at = ? WHERE id = ?").run(this.now(), id);
    return this.getTweet(id);
  }

  /** Live timeline: deleted tweets are hidden (but kept in the DB for inspection). */
  listTimeline(): Tweet[] {
    return this.db.prepare("SELECT * FROM tweets WHERE deleted_at IS NULL ORDER BY id").all() as Tweet[];
  }

  private getTweet(id: number): Tweet {
    const row = this.db.prepare("SELECT * FROM tweets WHERE id = ?").get(id) as Tweet | undefined;
    if (!row) throw new WorldError(`Tweet ${id} not found`);
    return row;
  }

  // ---- Bank (type I) -------------------------------------------------------

  listAccounts(): Account[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY id").all() as Account[];
  }

  transferFunds(input: { from: string; to: string; amountCents: number; memo?: string | undefined }): Transfer {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new WorldError("amount_cents must be a positive integer");
    }
    if (input.from === input.to) throw new WorldError("Cannot transfer to the same account");
    const run = this.db.transaction(() => {
      const from = this.getAccount(input.from);
      this.getAccount(input.to);
      if (from.balance_cents < input.amountCents) {
        throw new WorldError(
          `Insufficient funds in ${input.from}: balance ${fmtMoney(from.balance_cents)}, requested ${fmtMoney(input.amountCents)}`,
        );
      }
      this.db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(input.amountCents, input.from);
      this.db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(input.amountCents, input.to);
      const info = this.db
        .prepare("INSERT INTO transfers (from_account, to_account, amount_cents, memo, executed_at) VALUES (?, ?, ?, ?, ?)")
        .run(input.from, input.to, input.amountCents, input.memo ?? null, this.now());
      return this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(Number(info.lastInsertRowid)) as Transfer;
    });
    return run();
  }

  private getAccount(id: string): Account {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Account | undefined;
    if (!row) throw new WorldError(`Account ${id} not found`);
    return row;
  }

  listTransfers(): Transfer[] {
    return this.db.prepare("SELECT * FROM transfers ORDER BY id").all() as Transfer[];
  }

  // ---- Seed / inspect ------------------------------------------------------

  /** Wipe the world and load deterministic sample data (same names, emails and balances every time). */
  seed(): void {
    const run = this.db.transaction(() => {
      for (const t of ["transfers", "accounts", "tweets", "emails", "contacts"]) this.db.exec(`DELETE FROM ${t}`);
      this.db.exec("DELETE FROM sqlite_sequence");
      const t0 = "2026-01-01T09:00:00.000Z";
      const ins = this.db.prepare("INSERT INTO contacts (name, email, company, created_at) VALUES (?, ?, ?, ?)");
      ins.run("Ada Lovelace", "ada@analytical.engine", "Analytical Engines Ltd", t0);
      ins.run("Grace Hopper", "grace@cobol.navy", "US Navy", t0);
      ins.run("Linus Torvalds", "linus@kernel.org", "Linux Foundation", t0);
      this.db
        .prepare("INSERT INTO emails (to_addr, subject, body, in_reply_to, sent_at) VALUES (?, ?, ?, ?, ?)")
        .run("ada@analytical.engine", "Welcome aboard", "Hi Ada, glad to have you with us.", null, t0);
      this.db.prepare("INSERT INTO tweets (text, posted_at) VALUES (?, ?)").run("Hello world, we are live!", t0);
      const acc = this.db.prepare("INSERT INTO accounts (id, owner, balance_cents) VALUES (?, ?, ?)");
      acc.run("acc-ops", "Operations", 500_000);
      acc.run("acc-payroll", "Payroll", 1_000_000);
      acc.run("acc-vendor", "Vendor Escrow", 0);
    });
    run();
  }

  /** Full, human-readable dump of the world. Deleted tweets and the transfer log are shown on purpose. */
  inspect(): string {
    const lines: string[] = [];
    const section = (title: string) => lines.push("", `== ${title} ==`);

    section(`CONTACTS (${this.listContacts().length})`);
    for (const c of this.listContacts()) lines.push(`  #${c.id}  ${c.name} <${c.email}>${c.company ? `  ${c.company}` : ""}`);

    section(`EMAILS SENT (${this.listInbox().length})`);
    for (const e of this.listInbox()) {
      lines.push(`  #${e.id}  to ${e.to_addr}  "${e.subject}"${e.in_reply_to ? `  (reply to #${e.in_reply_to})` : ""}`);
      lines.push(`       ${e.body}`);
    }

    const tweets = this.db.prepare("SELECT * FROM tweets ORDER BY id").all() as Tweet[];
    section(`TWEETS (${tweets.length}, ${tweets.filter((t) => t.deleted_at).length} deleted)`);
    for (const t of tweets) lines.push(`  #${t.id}  ${t.deleted_at ? "[DELETED] " : ""}${t.text}`);

    section("ACCOUNTS");
    for (const a of this.listAccounts()) lines.push(`  ${a.id.padEnd(12)} ${a.owner.padEnd(14)} ${fmtMoney(a.balance_cents).padStart(12)}`);

    const transfers = this.listTransfers();
    section(`TRANSFERS (${transfers.length}) — irreversible`);
    for (const t of transfers) {
      lines.push(`  #${t.id}  ${t.from_account} -> ${t.to_account}  ${fmtMoney(t.amount_cents)}${t.memo ? `  "${t.memo}"` : ""}`);
    }
    lines.push("");
    return lines.join("\n");
  }
}

export function fmtMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
