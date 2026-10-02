import type { MapRule } from '../core/types';
import type { MatchableRequest } from './rule-store';

function escapeRegexChar(char: string): string {
  return '\\^$.*+?()[]{}|'.includes(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = '^';

  for (const char of pattern) {
    if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += escapeRegexChar(char);
    }
  }

  source += '$';
  return new RegExp(source, caseInsensitive ? 'i' : undefined);
}

export function matchesMapRule(rule: MapRule, request: MatchableRequest): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (rule.method !== '*' && rule.method !== request.method.toUpperCase()) {
    return false;
  }

  const candidate =
    rule.target === 'url'
      ? request.url
      : rule.target === 'host'
        ? request.host
        : request.path;

  return globToRegExp(rule.pattern, rule.target === 'host').test(candidate);
}
