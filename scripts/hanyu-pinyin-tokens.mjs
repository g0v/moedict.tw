/**
 * HanYu pinyin tokenization aligned with moedict-webkit build-pinyin-lookup.pl
 * analyze_pinyin_field semantics.
 */

export const CS_KNOWN_PINYIN_RE = new RegExp("(?:a(?:ir|n[gr]|[inor])|b(?:a(?:ir|n(?:gr|[gr])|or|[inor])|e(?:ir|n(?:gr|[gr])|[inr])|i(?:a(?:nr|or|[nor])|er|ng|[enr])|or|ur|[aiou])|c(?:a(?:ir|n[gr]|or|[inor])|e(?:ngr?|[nr])|h(?:a(?:ngr?|or|[inor])|e(?:n(?:gr|[gr])|[nr])|ir|o(?:ngr?|u)|u(?:a(?:ir|n(?:gr|[gr])|[inr])|or|[ainor])|[aeiu])|ir|o(?:ngr?|ur|u)|u(?:a(?:nr|[nr])|er|nr|or|[ino])|[aeiu])|d(?:a(?:ir|n(?:gr|[gr])|or|[inor])|e(?:ngr?|[inr])|i(?:a(?:nr|or|[nor])|er|ngr?|ur|[eru])|o(?:ngr?|ur|u)|u(?:a(?:nr|[nr])|er|ir|nr|or|[inor])|[aeiu])|e(?:ng|[nr])|f(?:a(?:n(?:gr|[gr])|[nr])|e(?:n(?:gr|[gr])|[inr])|ou|ur|[aou])|g(?:a(?:ir|n(?:gr|[gr])|or|[inor])|e(?:n(?:gr|[gr])|[inr])|o(?:ngr?|ur|u)|u(?:a(?:ir|n(?:gr|[gr])|[inr])|er|ir|nr|or|[ainor])|[aeu])|h(?:a(?:ir|n[gr]|or|[inor])|e(?:ir|ngr?|[inr])|o(?:ng|ur|u)|u(?:a(?:ir|n(?:gr|[gr])|[inr])|er|ir|nr|or|[ainor])|[aeu])|j(?:i(?:a(?:n[gr]|or|[nor])|er|n(?:gr|[gr])|ong|ur|[aenru])|u(?:a(?:nr|[nr])|er|[enr])|[iu])|k(?:a(?:ir|n[gr]|[inor])|e(?:ngr?|[nr])|o(?:ngr?|ur|u)|u(?:a(?:ir|n[gr]|[inr])|er|nr|[ainor])|[aeu])|l(?:a(?:n(?:gr|[gr])|or|[inor])|e(?:ngr?|[ir])|i(?:a(?:n(?:gr|[gr])|or|[nor])|er|ngr?|ur|[aenru])|o(?:ngr?|ur|u)|u(?:a(?:nr|[nr])|er|nr|or|[enor])|[aeiou])|m(?:a(?:n[gr]|or|[inor])|e(?:ir|n(?:gr|[gr])|[inr])|i(?:a(?:nr|or|[nor])|er|ngr?|[enru])|o[ru]|ur|[aeiou])|n(?:a(?:ngr?|or|[inor])|e(?:ng|[in])|i(?:a(?:n(?:gr|[gr])|or|[nor])|ng|ur|[enu])|o(?:ngr?|u)|u(?:a(?:nr|[nr])|er|[enor])|[aeiu])|ou|p(?:a(?:ir|n(?:gr|[gr])|or|[inor])|e(?:ir|n(?:gr|[gr])|[inr])|i(?:a(?:nr|or|[nor])|er|ng|[aenr])|o[ru]|ur|[aiou])|q(?:i(?:a(?:n(?:gr|[gr])|or|[nor])|er|n(?:gr|[gr])|ongr?|ur|[aenru])|u(?:a(?:nr|[nr])|er|[enr])|[iu])|r(?:a(?:ngr?|[no])|e(?:n[gr]|[nr])|ir|o(?:ng|ur|u)|u(?:a(?:nr|[nr])|[ino])|[eiu])|s(?:a(?:n(?:gr|[gr])|[inor])|e(?:ngr?|[inr])|h(?:a(?:ir|n(?:gr|[gr])|or|[inor])|e(?:n(?:gr|[gr])|[inr])|ir|our?|u(?:a(?:ngr?|[in])|er|ir|nr|or|[ainor])|[aeiu])|ir|o(?:ng|u)|u(?:an|er|ir|[ino])|[aeiu])|t(?:a(?:ir|n(?:gr|[gr])|or|[inor])|e(?:ngr?|r)|i(?:a(?:nr|or|[nor])|er|ngr?|[er])|o(?:ngr?|ur|u)|u(?:a(?:nr|[nr])|er|ir|[inor])|[aeiu])|w(?:a(?:n(?:gr|[gr])|[inr])|e(?:ir|n[gr]|[inr])|or|ur|[aou])|x(?:i(?:a(?:n(?:gr|[gr])|or|[nor])|er|n(?:gr|[gr])|ong|ur|[aenru])|u(?:a(?:nr|[nr])|er|nr|[enr])|[iu])|y(?:a(?:n(?:gr|[gr])|or|[inor])|er|i(?:n(?:gr|[gr])|[nr])|o(?:ng|ur|u)|u(?:a(?:nr|[nr])|er|[enr])|[aeiou])|z(?:a(?:ng|or|[inor])|e(?:ngr?|[inr])|h(?:a(?:n(?:gr|[gr])|or|[inor])|e(?:n(?:gr|[gr])|[inr])|ir|o(?:ngr?|ur|u)|u(?:a(?:n(?:gr|[gr])|[inr])|er|ir|nr|or|[ainor])|[aeiu])|ir|o(?:ngr?|u)|u(?:a(?:nr|[nr])|er|ir|or|[inor])|[aeiu])|[aeoq])", 'g');

export function analyzePinyinField(value, lang = 'a') {
	const stripped = String(value ?? '')
		.normalize('NFD')
		.replace(/\p{Mark}/gu, '')
		.replace(/ɑ/g, 'a');

	let tokens = stripped
		.split(/([a-z]+)/i)
		.filter((token) => /^[a-z]/.test(token));

	if (lang === 'c') {
		// Perl uses split(/($re)/) so matched syllables are retained; plain split drops them.
		const syllableSplit = new RegExp(`(${CS_KNOWN_PINYIN_RE.source})`);
		tokens = tokens
			.flatMap((token) => token.split(syllableSplit))
			.filter(Boolean);
	}

	return tokens;
}
