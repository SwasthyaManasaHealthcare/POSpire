/**
 * Does a picker query match a stored mobile number? Compares digits only, so
 * spacing, a country code ("+91") or a leading 0 on either side don't matter.
 */
export function mobileMatches(query, mobile) {
	// A leading 0 is a dialling prefix, not part of the number.
	const queryDigits = (query || "").replace(/\D/g, "").replace(/^0+/, "");
	const mobileDigits = (mobile || "").replace(/\D/g, "").replace(/^0+/, "");
	if (queryDigits.length < 3 || !mobileDigits) return false;
	if (mobileDigits.includes(queryDigits)) return true;
	// The query carries a country code the stored number lacks.
	return mobileDigits.length >= 7 && queryDigits.endsWith(mobileDigits);
}
