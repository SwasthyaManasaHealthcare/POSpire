/**
 * Does a picker query match a stored mobile number? Compares digits only, so
 * spacing, "+91" or a leading 0 on either side don't matter.
 */
export function mobileMatches(query, mobile) {
	const queryDigits = (query || "").replace(/\D/g, "");
	const mobileDigits = (mobile || "").replace(/\D/g, "");
	return (
		(queryDigits.length >= 3 && mobileDigits.includes(queryDigits)) ||
		// Query carries a country code or leading 0 the stored number lacks.
		(mobileDigits.length >= 7 && queryDigits.endsWith(mobileDigits))
	);
}
