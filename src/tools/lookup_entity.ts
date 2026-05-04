/**
 * Closure-bound lookup tools for contacts and businesses (ADR 0036).
 *
 * Project is baked into the tool's closure so a project-A agent cannot
 * accidentally read project-B rows. Spliced into the run registry by
 * `buildRunRegistry` only when a `project` is set, mirroring how the board
 * tools work.
 *
 * Both tools surface the entity's curated soul body so the agent can answer
 * "what is X up to lately?" without injecting souls into every system prompt.
 */

import type { Database } from "bun:sqlite";
import type { ToolDescriptor } from "./registry.ts";
import { toolErr, toolOk, getString } from "./registry.ts";
import { resolvePrompt } from "../prompts/resolve.ts";
import {
  getContact,
  listContacts,
  listContactBusinessSummaries,
  listBusinessContactSummaries,
} from "../memory/contacts.ts";
import {
  findBusinessByDomain,
  findBusinessByName,
  getBusiness,
  listBusinesses,
} from "../memory/businesses.ts";

export const LOOKUP_CONTACT_TOOL_NAME = "lookup_contact";
export const LOOKUP_BUSINESS_TOOL_NAME = "lookup_business";
export const LOOKUP_TOOL_NAMES = [
  LOOKUP_CONTACT_TOOL_NAME,
  LOOKUP_BUSINESS_TOOL_NAME,
] as const;

export interface LookupToolContext {
  db: Database;
  project: string;
}

function getNumber(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function lookupContactTool(ctx: LookupToolContext): ToolDescriptor {
  return {
    name: LOOKUP_CONTACT_TOOL_NAME,
    description: resolvePrompt("tools.lookup_contact.description", {
      project: ctx.project,
    }),
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Numeric contact id (preferred when known).",
        },
        name: {
          type: "string",
          description:
            "Exact contact name to look up (case-insensitive, project-scoped).",
        },
        email: {
          type: "string",
          description: "Exact email address to look up.",
        },
      },
    },
    handler: async (args) => {
      const id = getNumber(args, "id");
      const name = getString(args, "name")?.trim();
      const email = getString(args, "email")?.trim().toLowerCase();
      if (!id && !name && !email) {
        return toolErr("provide at least one of {id, name, email}");
      }
      let contact = id ? getContact(ctx.db, id) : null;
      if (!contact && (name || email)) {
        // Use listContacts with a search term — broad LIKE match.
        const found = listContacts(ctx.db, ctx.project, {
          search: name ?? email!,
          limit: 5,
        });
        contact =
          found.contacts.find(
            (c) =>
              (name && c.name.toLowerCase() === name.toLowerCase()) ||
              (email && c.emails.some((e) => e.toLowerCase() === email)),
          ) ?? null;
      }
      if (!contact || contact.project !== ctx.project) {
        return toolErr("contact not found in this project");
      }
      const businesses = listContactBusinessSummaries(ctx.db, contact.id).map(
        (l) => ({
          id: l.businessId,
          name: l.businessName,
          domain: l.businessDomain,
          role: l.role,
          isPrimary: l.isPrimary,
        }),
      );
      return toolOk({
        id: contact.id,
        name: contact.name,
        emails: contact.emails,
        phones: contact.phones,
        company: contact.company,
        title: contact.title,
        tags: contact.tags,
        socials: contact.socials,
        soul: contact.soul,
        soulRefreshedAt: contact.soulRefreshedAt,
        notes: contact.notes,
        businesses,
      });
    },
  };
}

function lookupBusinessTool(ctx: LookupToolContext): ToolDescriptor {
  return {
    name: LOOKUP_BUSINESS_TOOL_NAME,
    description: resolvePrompt("tools.lookup_business.description", {
      project: ctx.project,
    }),
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Numeric business id (preferred when known).",
        },
        name: {
          type: "string",
          description:
            "Exact organisation name to look up (case-insensitive, project-scoped).",
        },
        domain: {
          type: "string",
          description: "Exact domain to look up (e.g. 'acme.com').",
        },
      },
    },
    handler: async (args) => {
      const id = getNumber(args, "id");
      const name = getString(args, "name")?.trim();
      const domain = getString(args, "domain")?.trim().toLowerCase();
      if (!id && !name && !domain) {
        return toolErr("provide at least one of {id, name, domain}");
      }
      let business = id ? getBusiness(ctx.db, id) : null;
      if (!business && name) {
        business = findBusinessByName(ctx.db, ctx.project, name);
      }
      if (!business && domain) {
        business = findBusinessByDomain(ctx.db, ctx.project, domain);
      }
      if (!business && (name || domain)) {
        const found = listBusinesses(ctx.db, ctx.project, {
          search: name ?? domain!,
          limit: 5,
        });
        business =
          found.businesses.find(
            (b) =>
              (name && b.name.toLowerCase() === name.toLowerCase()) ||
              (domain && b.domain === domain),
          ) ?? null;
      }
      if (!business || business.project !== ctx.project) {
        return toolErr("business not found in this project");
      }
      const contacts = listBusinessContactSummaries(ctx.db, business.id).map(
        (l) => ({
          id: l.contactId,
          name: l.contactName,
          role: l.role,
          isPrimary: l.isPrimary,
        }),
      );
      return toolOk({
        id: business.id,
        name: business.name,
        domain: business.domain,
        website: business.website,
        emails: business.emails,
        phones: business.phones,
        socials: business.socials,
        tags: business.tags,
        description: business.description,
        notes: business.notes,
        soul: business.soul,
        soulRefreshedAt: business.soulRefreshedAt,
        address: business.address,
        contacts,
      });
    },
  };
}

export function makeLookupTools(ctx: LookupToolContext): ToolDescriptor[] {
  return [lookupContactTool(ctx), lookupBusinessTool(ctx)];
}
