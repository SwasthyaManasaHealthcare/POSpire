import { CARD_COLORS } from "./palette";
import {
	formatCurrency,
	formatNumber,
	formatCompactCurrency,
	formatHourLabel,
} from "@/utils/dashboardFormat";

const CARD = (dataKey, valueType) => ({
	type: "number-card",
	resolve: (slice) => ({
		value: slice?.value ?? 0,
		valueType,
		trend: slice?.trend ?? { status: "no_previous", percentage: null, label: "" },
		iconColor: CARD_COLORS[dataKey]?.color,
		iconBg: CARD_COLORS[dataKey]?.background,
	}),
});

export const CATALOG = {
	total_net_sales: CARD("total_net_sales", "currency"),
	bill_count: CARD("bill_count", "number"),
	loyalty_redemptions: CARD("loyalty_redemptions", "points"),
	total_returns: CARD("total_returns", "currency"),
	held_invoices: CARD("held_invoices", "number"),
	cancelled_invoices: CARD("cancelled_invoices", "number"),

	hourly_sales: {
		type: "chart",
		resolve: (slice) => ({
			labels: (slice?.labels || []).map(formatHourLabel),
			values: slice?.values || [],
			valueFormat: formatCompactCurrency,
		}),
	},

	payment_distribution: {
		type: "chart",
		resolve: (slice) => ({
			labels: (slice || []).map((r) => r.mode_of_payment || __("Unknown")),
			values: (slice || []).map((r) => Number(r.amount) || 0),
			valueFormat: formatCurrency,
		}),
	},

	top_products: {
		type: "table",
		resolve: (slice) => ({
			rows: slice || [],
			columns: [
				{ key: "item_name", label: __("Product"), width: "minmax(0, 1fr)" },
				{ key: "total_qty", label: __("Qty"), align: "right", width: "76px", format: formatNumber },
				{
					key: "total_sales",
					label: __("Sales"),
					align: "right",
					width: "110px",
					format: formatCurrency,
				},
			],
		}),
	},

	top_categories: {
		type: "table",
		resolve: (slice) => ({
			rows: slice || [],
			columns: [
				{ key: "item_group", label: __("Category"), width: "minmax(92px, 0.75fr)" },
				{
					key: "total_sales_bar",
					label: "",
					bar: true,
					barValueKey: "total_sales",
					width: "minmax(120px, 1.4fr)",
				},
				{
					key: "total_sales",
					label: __("Sales"),
					align: "right",
					width: "96px",
					format: formatCurrency,
				},
			],
		}),
	},

	shift_summary: {
		type: "table",
		resolve: (slice) => ({
			previewLimit: 99,
			rows: [
				{ label: __("Opening Float"), value: formatCurrency(slice?.opening_float || 0) },
				{ label: __("Cash Sales"), value: `+${formatCurrency(slice?.cash_sales || 0)}` },
				{ label: __("Cash In"), value: `+${formatCurrency(slice?.cash_in || 0)}` },
				{ label: __("Cash Out"), value: `-${formatCurrency(slice?.cash_out || 0)}` },
			],
			columns: [
				{ key: "label", label: __("Shift Summary"), width: "minmax(0, 1fr)" },
				{ key: "value", label: "", align: "right", width: "140px" },
			],
		}),
	},
};

const DEFAULT_SPAN = { "number-card": 4, chart: 6, table: 6 };

export function resolveWidget(descriptor, slice) {
	const entry = CATALOG[descriptor.data_key];
	if (!entry) return null;

	const resolved = entry.resolve(slice);
	const props = {
		title: descriptor.title || undefined,
		...resolved,
	};
	if (entry.type === "number-card" && descriptor.icon) props.icon = descriptor.icon;
	if (entry.type === "chart") props.variant = descriptor.variant || "line";

	return {
		type: entry.type,
		props,
		colSpan: descriptor.column_span || DEFAULT_SPAN[entry.type] || 6,
	};
}
