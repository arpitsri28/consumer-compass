// No raw HTML or remote images. Keep react-markdown's default safe URL transformation.
export const markdownOptions = { skipHtml: true, disallowedElements: ["img"] };
