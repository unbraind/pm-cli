/** Markdown navigation analysis shared by the docs gate and its negative controls. */
import path from "node:path";
import GithubSlugger from "github-slugger";
import { parseFragment } from "parse5";
import { Lexer, Parser, Renderer, walkTokens } from "marked";

/** Read text and actual anchor attributes without rendering or executing HTML. */
function inspectHtml(content) {
  const pending = [parseFragment(content)];
  const anchors = [];
  let text = "";
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.nodeName === "#text") text += node.value;
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === "id" || attribute.name === "name")
        anchors.push(attribute.value);
    }
    pending.push(...(node.childNodes ?? []).slice().reverse());
  }
  return { text, anchors };
}

/** Read rendered headings, custom HTML anchors and actual links, excluding code examples. */
export function inspectMarkdown(content) {
  const anchors = new Set();
  const links = [];
  const navigationLinks = [];
  const slugger = new GithubSlugger();
  const renderer = new Renderer();
  const parser = new Parser({ renderer });
  renderer.image = ({ tokens }) => parser.parseInline(tokens);
  walkTokens(Lexer.lex(content), (token) => {
    if (token.type === "heading") {
      const { text } = inspectHtml(parser.parseInline(token.tokens));
      anchors.add(slugger.slug(text));
    }
    if (token.type === "link" || token.type === "image") {
      if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(token.href)) {
        links.push(token.href);
        if (token.type === "link") navigationLinks.push(token.href);
      }
    }
    if (token.type === "html") {
      for (const anchor of inspectHtml(token.text).anchors) anchors.add(anchor);
    }
  });
  return { anchors, links, navigationLinks };
}

/** Resolve local URL paths and decoded fragments, including fragment-only links. */
export function resolveDocumentationTarget(source, href) {
  const hash = href.indexOf("#");
  const pathname = (hash < 0 ? href : href.slice(0, hash)).split("?")[0];
  try {
    const decoded = decodeURIComponent(pathname);
    return {
      path:
        decoded === ""
          ? source
          : path.posix.normalize(
              decoded.startsWith("/")
                ? decoded.slice(1)
                : path.posix.join(path.posix.dirname(source), decoded),
            ),
      fragment: hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * Validate fragment targets and traverse from the advertised docs index. A cycle
 * disconnected from the index remains unreachable. Exceptions name individual
 * documents and a reason; they never create navigation roots for other files.
 */
export function inspectDocumentationGraph(documents, exceptions = new Map()) {
  const failures = [];
  const parsed = new Map(
    [...documents].map(([name, content]) => [name, inspectMarkdown(content)]),
  );
  const edges = documentationEdges(parsed, failures);
  const reached = new Set();
  const pending = ["docs/README.md"];
  while (pending.length > 0) {
    const current = pending.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    pending.push(...(edges.get(current) ?? []));
  }
  for (const [name, reason] of exceptions) {
    if (!documents.has(name))
      failures.push(`Stale documentation reachability exception: ${name}`);
    if (typeof reason !== "string" || reason.trim() === "")
      failures.push(
        `Documentation reachability exception requires a reason: ${name}`,
      );
  }
  for (const name of documents.keys()) {
    if (name.startsWith("docs/") && !reached.has(name) && !exceptions.has(name))
      failures.push(
        `Unreachable documentation: ${name}; link it from docs/README.md or a reachable document`,
      );
  }
  return failures;
}

/** Resolve the navigation edges and validate fragments before traversing the graph. */
function documentationEdges(parsed, failures) {
  const edges = new Map();
  for (const [name, document] of parsed) {
    const targets = [];
    const navigationTargets = new Set(document.navigationLinks);
    for (const href of document.links) {
      const target = resolveDocumentationTarget(name, href);
      if (!target) {
        failures.push(`Malformed documentation URL "${href}" in ${name}`);
        continue;
      }
      const destination = parsed.get(target.path);
      if (!destination) continue; // Filesystem existence is checked by the caller.
      if (navigationTargets.has(href)) targets.push(target.path);
      if (target.fragment && !destination.anchors.has(target.fragment))
        failures.push(`Broken documentation anchor "${href}" in ${name}`);
    }
    edges.set(name, targets);
  }
  return edges;
}
