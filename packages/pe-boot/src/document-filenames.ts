const PORTABLE_PUNCTUATION: Readonly<Record<string, string>> = {
	":": "：",
	"<": "＜",
	">": "＞",
	'"': "＂",
	"|": "｜",
	"?": "？",
	"*": "＊",
};

/** Preserve legal Unicode names; map only ASCII punctuation that is invalid on Windows. */
export function portablePeFilename(value: string): string {
	return value
		.normalize("NFC")
		.trim()
		.replace(/[:<>"|?*]/gu, (character) => PORTABLE_PUNCTUATION[character] ?? character);
}
