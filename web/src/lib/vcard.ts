export interface ParsedSocial {
  platform: string;
  handle: string;
  url?: string;
}

export interface ParsedVCard {
  name: string;
  emails: string[];
  phones: string[];
  company: string;
  title: string;
  notes: string;
  socials: ParsedSocial[];
  photo: string | null;
}

/**
 * Map well-known X-* legacy properties to a canonical platform tag. Returns
 * null when the property is not a recognised social-handle property.
 */
function legacySocialPlatform(prop: string): string | null {
  switch (prop) {
    case "X-TWITTER":
      return "twitter";
    case "X-LINKEDIN":
      return "linkedin";
    case "X-GITHUB":
      return "github";
    case "X-FACEBOOK":
      return "facebook";
    case "X-INSTAGRAM":
      return "instagram";
    case "X-MASTODON":
      return "mastodon";
    case "X-BLUESKY":
      return "bluesky";
    case "X-AIM":
    case "X-SKYPE":
      return "other";
    default:
      return null;
  }
}

/** Try to parse `type=foo` (case-insensitive) out of a vCard params string. */
function paramType(params: string): string | null {
  const m = params.match(/(?:^|;)\s*type=([^;]+)/i);
  return m && m[1] ? m[1].toLowerCase().trim() : null;
}

function unfoldLines(raw: string): string[] {
  return raw.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function extractPropAndParams(line: string): { prop: string; params: string; value: string } {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return { prop: "", params: "", value: "" };
  const before = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const semiIdx = before.indexOf(";");
  if (semiIdx < 0) return { prop: before.toUpperCase(), params: "", value };
  return { prop: before.slice(0, semiIdx).toUpperCase(), params: before.slice(semiIdx + 1), value };
}

function parseSingleVCard(lines: string[]): ParsedVCard {
  let name = "";
  const emails: string[] = [];
  const phones: string[] = [];
  let company = "";
  let title = "";
  let notes = "";
  let photo: string | null = null;
  const socials: ParsedSocial[] = [];

  for (const line of lines) {
    const { prop, params, value } = extractPropAndParams(line);

    switch (prop) {
      case "FN":
        name = value;
        break;
      case "N":
        if (!name) {
          const parts = value.split(";");
          name = [parts[1], parts[0]].filter(Boolean).join(" ").trim();
        }
        break;
      case "EMAIL":
        if (value) emails.push(value);
        break;
      case "TEL":
        if (value) phones.push(value);
        break;
      case "ORG":
        company = value.replace(/;+$/, "").replace(/;/g, " / ");
        break;
      case "TITLE":
        title = value;
        break;
      case "NOTE":
        notes = value.replace(/\\n/g, "\n").replace(/\\,/g, ",");
        break;
      case "URL":
        if (value)
          socials.push({ platform: "website", handle: value, url: value });
        break;
      case "X-SOCIALPROFILE": {
        // Apple iCloud format: X-SOCIALPROFILE;type=twitter:https://...
        const platform = paramType(params) ?? "other";
        if (value)
          socials.push({
            platform,
            handle: value,
            url: /^https?:\/\//i.test(value) ? value : undefined,
          });
        break;
      }
      case "IMPP": {
        // RFC 4770: IMPP:xmpp:user@host or IMPP;X-SERVICE-TYPE=Mastodon:...
        const m = value.match(/^([a-zA-Z]+):(.+)$/);
        const scheme = m && m[1] ? m[1].toLowerCase() : null;
        const rest = m && m[2] ? m[2] : value;
        const platform =
          scheme === "xmpp"
            ? "mastodon"
            : (paramType(params) ?? scheme ?? "other");
        if (rest) socials.push({ platform, handle: rest });
        break;
      }
      case "PHOTO": {
        const paramsUpper = params.toUpperCase();
        if (paramsUpper.includes("ENCODING=B") || paramsUpper.includes("ENCODING=BASE64")) {
          const typeMatch = paramsUpper.match(/TYPE=([A-Z]+)/);
          const mime = typeMatch
            ? `image/${typeMatch[1]!.toLowerCase()}`
            : "image/jpeg";
          photo = `data:${mime};base64,${value}`;
        } else if (value.startsWith("data:")) {
          photo = value;
        }
        break;
      }
      default: {
        const platform = legacySocialPlatform(prop);
        if (platform && value) {
          socials.push({
            platform,
            handle: value,
            url: /^https?:\/\//i.test(value) ? value : undefined,
          });
        }
        break;
      }
    }
  }

  return { name, emails, phones, company, title, notes, socials, photo };
}

export function parseVCards(vcfText: string): ParsedVCard[] {
  const lines = unfoldLines(vcfText);
  const cards: ParsedVCard[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const upper = line.toUpperCase().trim();
    if (upper === "BEGIN:VCARD") {
      current = [];
    } else if (upper === "END:VCARD") {
      if (current) {
        const card = parseSingleVCard(current);
        if (card.name) cards.push(card);
        current = null;
      }
    } else if (current) {
      current.push(line);
    }
  }

  return cards;
}

