"""Desk boot customizations for POSpire."""

HIDDEN_AWESOME_BAR_DOCTYPES = frozenset(
	{
		"POS Invoice",
	}
)

AWESOME_BAR_DOCTYPE_KEYS = (
	"can_read",
	"can_search",
	"can_create",
)


def filter_core_pos_doctypes_from_bootinfo(bootinfo):
	"""Hide ERPNext Core POS DocTypes from Desk discovery data."""
	user = bootinfo.get("user") if hasattr(bootinfo, "get") else None
	if not user:
		return

	for key in AWESOME_BAR_DOCTYPE_KEYS:
		values = user.get(key) if hasattr(user, "get") else None
		if not isinstance(values, list):
			continue

		user[key] = [value for value in values if value not in HIDDEN_AWESOME_BAR_DOCTYPES]
