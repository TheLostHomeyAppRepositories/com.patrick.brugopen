'use strict';

function normAlias(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Public/common names that differ from the technical Rijkswaterstaat FIS name.
// Keep this list small and only add aliases that can be tied unambiguously to a FIS object.
const BRIDGE_ALIASES = [
  {
    technicalName: 'Brug over binnenhoofd Julianasluis',
    publicName: 'Julianasluisbrug Noord',
    searchTerm: 'Julianasluis',
    aliases: [
      'Julianasluisbrug Noord',
      'Julianasluisbruggen Noord',
      'Noordbrug Gouda',
    ],
  },
  {
    technicalName: 'Brug over buitenhoofd Julianasluis',
    publicName: 'Julianasluisbrug Zuid',
    searchTerm: 'Julianasluis',
    aliases: [
      'Julianasluisbrug Zuid',
      'Julianasluisbruggen Zuid',
      'Zuidbrug Gouda',
    ],
  },
];

const BY_TECHNICAL_NAME = new Map(
  BRIDGE_ALIASES.map(item => [normAlias(item.technicalName), item]),
);

function applyBridgeAlias(bridge) {
  if (!bridge) return bridge;
  const originalName = String(bridge.name || '').trim();
  const alias = BY_TECHNICAL_NAME.get(normAlias(originalName));
  if (!alias) {
    return {
      ...bridge,
      sourceName: bridge.sourceName || originalName,
      searchNames: [...new Set([originalName, ...(bridge.searchNames || [])].filter(Boolean))],
    };
  }
  return {
    ...bridge,
    sourceName: originalName,
    name: alias.publicName,
    searchNames: [...new Set([
      alias.publicName,
      originalName,
      ...(alias.aliases || []),
      ...(bridge.searchNames || []),
    ].filter(Boolean))],
  };
}

function aliasSearchTerm(query) {
  const q = normAlias(query);
  if (!q) return '';
  for (const item of BRIDGE_ALIASES) {
    const names = [item.publicName, item.technicalName, ...(item.aliases || [])]
      .map(normAlias)
      .filter(Boolean);
    if (names.some(name => name === q || name.includes(q) || q.includes(name))) {
      return item.searchTerm;
    }
  }
  return '';
}

module.exports = {
  BRIDGE_ALIASES,
  applyBridgeAlias,
  aliasSearchTerm,
  normAlias,
};
