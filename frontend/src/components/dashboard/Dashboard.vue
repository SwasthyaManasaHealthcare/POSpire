<template>
  <v-container fluid class="dashboard-page">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">
      {{ error }}
    </v-alert>

    <div v-if="loading" class="dashboard-page__state">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <v-row v-else class="dashboard-page__grid" dense>
      <v-col
        v-for="card in cardItems"
        :key="card.key"
        cols="12"
        sm="6"
        md="4"
      >
        <v-card class="dashboard-card" elevation="1">
          <v-card-text class="dashboard-card__content">
            <div class="dashboard-card__copy">
              <div class="dashboard-card__title">{{ card.title }}</div>
              <div class="dashboard-card__value">{{ formatCardValue(card) }}</div>
            </div>
            <div
              class="dashboard-card__icon"
              :style="{ '--card-accent': card.color, '--card-accent-bg': card.background }"
            >
              <v-icon :icon="card.icon" size="24" />
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

	    <v-row v-if="!loading" class="dashboard-graphs" dense>
      <v-col cols="12" md="6">
        <v-card class="dashboard-chart-card" elevation="1">
          <v-card-title class="dashboard-chart-card__title">
            {{ __("Hourly Sales") }}
          </v-card-title>
          <v-card-text class="dashboard-chart-card__body">
            <svg
              :viewBox="`0 0 ${chartWidth} ${chartHeight}`"
              class="dashboard-line-chart"
              role="img"
              :aria-label="__('Hourly Sales')"
            >
              <defs>
                <linearGradient id="hourly-sales-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stop-color="#2563eb" stop-opacity="0.18" />
                  <stop offset="100%" stop-color="#2563eb" stop-opacity="0.02" />
                </linearGradient>
              </defs>
              <g v-for="tick in yTicks" :key="`hourly-y-${tick.value}`">
                <line
                  :x1="chartPadding"
                  :y1="tick.y"
                  :x2="chartWidth - chartPadding"
                  :y2="tick.y"
                  class="dashboard-line-chart__grid"
                />
                <text
                  :x="chartPadding - 10"
                  :y="tick.y + 4"
                  text-anchor="end"
                  class="dashboard-line-chart__label"
                >
                  {{ formatCompactCurrency(tick.value) }}
                </text>
              </g>
              <line
                :x1="chartPadding"
                :y1="chartBottom"
                :x2="chartWidth - chartPadding"
                :y2="chartBottom"
                class="dashboard-line-chart__axis"
              />
              <line
                :x1="chartPadding"
                :y1="chartTop"
                :x2="chartPadding"
                :y2="chartBottom"
                class="dashboard-line-chart__axis"
              />
              <path
                v-if="chartPath"
                :d="areaPath"
                class="dashboard-line-chart__area"
              />
              <path
                v-if="chartPath"
                :d="chartPath"
                fill="none"
                class="dashboard-line-chart__line"
              />
              <g v-for="point in chartPoints" :key="`hourly-point-${point.index}`">
                <circle
                  :cx="point.x"
                  :cy="point.y"
                  r="4"
                  class="dashboard-line-chart__dot"
                />
                <title>{{ point.label }}: {{ formatCurrency(point.value) }}</title>
              </g>
              <text
                v-for="point in xAxisLabels"
                :key="`hourly-x-${point.index}`"
                :x="point.x"
                :y="chartHeight - 12"
                text-anchor="middle"
                class="dashboard-line-chart__label"
              >
                {{ formatHourLabel(point.label) }}
              </text>
            </svg>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="6">
        <v-card class="dashboard-chart-card" elevation="1">
          <v-card-title class="dashboard-chart-card__title">
            {{ __("Payment Distribution") }}
          </v-card-title>
          <v-card-text class="dashboard-chart-card__body dashboard-payment-card__body">
            <div v-if="hasPaymentData" class="dashboard-payment-chart">
              <svg
                :viewBox="`0 0 ${donutWidth} ${donutHeight}`"
                class="dashboard-donut-chart"
                role="img"
                :aria-label="__('Payment Distribution')"
              >
                <circle
                  :cx="donutCenter"
                  :cy="donutCenter"
                  :r="donutRadius"
                  class="dashboard-donut-chart__track"
                />
                <circle
                  v-for="segment in paymentSegments"
                  :key="segment.mode"
                  :cx="donutCenter"
                  :cy="donutCenter"
                  :r="donutRadius"
                  :stroke="segment.color"
                  :stroke-dasharray="segment.dashArray"
                  :stroke-dashoffset="segment.dashOffset"
                  class="dashboard-donut-chart__segment"
                  :transform="`rotate(-90 ${donutCenter} ${donutCenter})`"
                >
                  <title>{{ segment.mode }}: {{ formatCurrency(segment.amount) }}</title>
                </circle>
                <text
                  :x="donutCenter"
                  :y="donutCenter - 4"
                  text-anchor="middle"
                  class="dashboard-donut-chart__total-label"
                >
                  {{ __("Total") }}
                </text>
                <text
                  :x="donutCenter"
                  :y="donutCenter + 18"
                  text-anchor="middle"
                  class="dashboard-donut-chart__total"
                >
                  {{ formatCompactCurrency(paymentTotal) }}
                </text>
              </svg>
              <div class="dashboard-payment-legend">
                <div
                  v-for="segment in paymentSegments"
                  :key="`legend-${segment.mode}`"
                  class="dashboard-payment-legend__item"
                >
                  <span
                    class="dashboard-payment-legend__dot"
                    :style="{ backgroundColor: segment.color }"
                  ></span>
                  <span class="dashboard-payment-legend__mode">{{ segment.mode }}</span>
                  <span class="dashboard-payment-legend__amount">
                    {{ formatCurrency(segment.amount) }}
                  </span>
                </div>
              </div>
            </div>
            <div v-else class="dashboard-payment-empty">
              <svg
                :viewBox="`0 0 ${donutWidth} ${donutHeight}`"
                class="dashboard-donut-chart dashboard-donut-chart--empty"
                role="img"
                :aria-label="__('No payment data available')"
              >
                <circle
                  :cx="donutCenter"
                  :cy="donutCenter"
                  :r="donutRadius"
                  class="dashboard-donut-chart__track"
                />
              </svg>
              <div class="dashboard-payment-empty__text">
                {{ __("No payment data available") }}
              </div>
            </div>
          </v-card-text>
        </v-card>
	      </v-col>
	    </v-row>

	    <v-row v-if="!loading" class="dashboard-graphs dashboard-graphs--secondary" dense>
	      <v-col cols="12" md="6">
	        <v-card class="dashboard-chart-card" elevation="1">
	          <v-card-title class="dashboard-chart-card__title dashboard-table-card__title">
	            <span>{{ __("Top Selling Products") }}</span>
	            <button
	              v-if="hasProductToggle"
	              type="button"
	              class="dashboard-table-card__link"
	              @click="toggleProductsView"
	            >
	              {{ showAllProducts ? __("Show Less") : __("View All") }}
	            </button>
	          </v-card-title>
	          <v-card-text class="dashboard-chart-card__body dashboard-products-card__body">
	            <div v-if="hasTopProductsData" class="dashboard-products-table">
	              <div class="dashboard-products-table__header">
	                <span class="dashboard-products-table__rank">#</span>
	                <span>{{ __("Product") }}</span>
	                <span class="dashboard-products-table__number">{{ __("Qty") }}</span>
	                <span class="dashboard-products-table__number">{{ __("Sales") }}</span>
	              </div>
	              <div
	                class="dashboard-products-table__body"
	                :class="{ 'dashboard-products-table__body--scroll': showAllProducts }"
	              >
	                <div
	                  v-for="product in visibleTopProducts"
	                  :key="product.item_code || product.rank"
	                  class="dashboard-products-table__row"
	                >
	                  <span class="dashboard-products-table__rank">{{ product.rank }}</span>
	                  <span class="dashboard-products-table__product" :title="product.item_name">
	                    {{ product.item_name }}
	                  </span>
	                  <span class="dashboard-products-table__number">
	                    {{ formatNumber(product.total_qty) }}
	                  </span>
	                  <span class="dashboard-products-table__number dashboard-products-table__sales">
	                    {{ formatCurrency(product.total_sales) }}
	                  </span>
	                </div>
	              </div>
	            </div>
	            <div v-else class="dashboard-products-empty">
	              {{ __("No product sales available") }}
	            </div>
	          </v-card-text>
	        </v-card>
	      </v-col>

	      <v-col cols="12" md="6">
	        <v-card class="dashboard-chart-card" elevation="1">
	          <v-card-title class="dashboard-chart-card__title dashboard-table-card__title">
	            <span>{{ __("Top Selling Categories") }}</span>
	            <button
	              v-if="hasCategoryToggle"
	              type="button"
	              class="dashboard-table-card__link"
	              @click="toggleCategoriesView"
	            >
	              {{ showAllCategories ? __("Show Less") : __("View All") }}
	            </button>
	          </v-card-title>
	          <v-card-text class="dashboard-chart-card__body dashboard-products-card__body">
	            <div v-if="hasTopCategoriesData" class="dashboard-categories-chart">
	              <div
	                class="dashboard-categories-chart__body"
	                :class="{ 'dashboard-categories-chart__body--scroll': showAllCategories }"
	              >
	                <div
	                  v-for="category in visibleTopCategories"
	                  :key="category.item_group || category.rank"
	                  class="dashboard-categories-chart__row"
	                >
	                  <span class="dashboard-categories-chart__name" :title="category.item_group">
	                    {{ category.item_group }}
	                  </span>
	                  <svg
	                    class="dashboard-categories-chart__bar"
	                    viewBox="0 0 100 10"
	                    preserveAspectRatio="none"
	                    role="img"
	                    :aria-label="`${category.item_group}: ${formatCurrency(category.total_sales)}`"
	                  >
	                    <rect
	                      x="0"
	                      y="0"
	                      width="100"
	                      height="10"
	                      rx="5"
	                      class="dashboard-categories-chart__track"
	                    />
	                    <rect
	                      x="0"
	                      y="0"
	                      :width="category.barWidth"
	                      height="10"
	                      rx="5"
	                      :fill="category.color"
	                    />
	                  </svg>
	                  <span class="dashboard-categories-chart__amount">
	                    {{ formatCurrency(category.total_sales) }}
	                  </span>
	                </div>
	              </div>
	            </div>
	            <div v-else class="dashboard-products-empty">
	              {{ __("No category sales available") }}
	            </div>
	          </v-card-text>
	        </v-card>
	      </v-col>
	    </v-row>
	  </v-container>
	</template>

<script>
import { computed, onMounted, ref } from "vue";
import { call } from "@/utils/call";

function emptyCards() {
  return {
    total_net_sales: 0,
    bill_count: 0,
    loyalty_redemptions: 0,
    total_returns: 0,
    held_invoices: 0,
    cancelled_invoices: 0,
  };
}

function emptyHourlySales() {
  return {
    labels: [],
    values: [],
  };
}

	function emptyPaymentDistribution() {
	  return [];
	}

	function emptyTopProducts() {
	  return [];
	}

	function emptyTopCategories() {
	  return [];
	}

export default {
  name: "Dashboard",
  setup() {
    const loading = ref(false);
    const error = ref("");
	    const cards = ref(emptyCards());
	    const hourlySales = ref(emptyHourlySales());
	    const paymentDistribution = ref(emptyPaymentDistribution());
	    const topProducts = ref(emptyTopProducts());
	    const topCategories = ref(emptyTopCategories());
	    const showAllProducts = ref(false);
	    const showAllCategories = ref(false);
    const cardItems = [
      {
        key: "total_net_sales",
        title: __("Total Net Sales"),
        type: "currency",
        icon: "mdi-cash-multiple",
        color: "#16a34a",
        background: "#dcfce7",
      },
      {
        key: "bill_count",
        title: __("Bills"),
        type: "number",
        icon: "mdi-receipt-text-outline",
        color: "#2563eb",
        background: "#dbeafe",
      },
      {
        key: "loyalty_redemptions",
        title: __("Loyalty"),
        type: "currency",
        icon: "mdi-star-circle-outline",
        color: "#7c3aed",
        background: "#ede9fe",
      },
      {
        key: "total_returns",
        title: __("Returns"),
        type: "currency",
        icon: "mdi-cash-refund",
        color: "#ea580c",
        background: "#ffedd5",
      },
      {
        key: "held_invoices",
        title: __("Held"),
        type: "number",
        icon: "mdi-pause-circle-outline",
        color: "#d97706",
        background: "#fef3c7",
      },
      {
        key: "cancelled_invoices",
        title: __("Cancelled"),
        type: "number",
        icon: "mdi-close-circle-outline",
        color: "#dc2626",
        background: "#fee2e2",
      },
    ];
    const chartWidth = 760;
    const chartHeight = 340;
    const chartPadding = 52;
    const chartTop = 14;
    const chartBottom = chartHeight - 42;
    const tickCount = 5;
    const donutWidth = 260;
    const donutHeight = 220;
    const donutCenter = 110;
    const donutRadius = 58;
    const donutCircumference = 2 * Math.PI * donutRadius;
	    const productPreviewLimit = 5;
	    const paymentColors = [
	      "#60a5fa",
      "#34d399",
      "#c084fc",
      "#fbbf24",
      "#fb7185",
      "#2dd4bf",
      "#a78bfa",
	      "#f97316",
	    ];
	    const categoryColors = ["#34d399", "#60a5fa", "#c084fc", "#f97316", "#2dd4bf"];

    const maxHourlySales = computed(() =>
      hourlySales.value.values.reduce((max, value) => Math.max(max, Number(value) || 0), 0),
    );

    const yAxisStep = computed(() => niceTickStep(maxHourlySales.value, tickCount));

    const yAxisMax = computed(() => yAxisStep.value * (tickCount - 1));

    const yTicks = computed(() => {
      return Array.from({ length: tickCount }, (_, index) => {
        const value = yAxisMax.value - yAxisStep.value * index;
        return {
          value,
          y: chartTop + (index / (tickCount - 1)) * (chartBottom - chartTop),
        };
      });
    });

    const chartPoints = computed(() => {
      const labels = hourlySales.value.labels || [];
      if (!labels.length) return [];

      const values = hourlySales.value.values || [];
      const plotWidth = chartWidth - chartPadding * 2;
      const plotHeight = chartBottom - chartTop;
      const xStep = labels.length > 1 ? plotWidth / (labels.length - 1) : 0;

      return labels.map((label, index) => {
        const value = Number(values[index]) || 0;
        const x = labels.length === 1 ? chartWidth / 2 : chartPadding + index * xStep;
        const y = chartBottom - (value / yAxisMax.value) * plotHeight;

        return {
          label,
          value,
          index,
          x,
          y,
        };
      });
    });

    const chartPath = computed(() => {
      const points = chartPoints.value;
      if (!points.length) return "";
      if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

      return points.reduce((path, point, index) => {
        if (index === 0) return `M ${point.x} ${point.y}`;

        const previous = points[index - 1];
        const controlX = previous.x + (point.x - previous.x) / 2;
        return `${path} C ${controlX} ${previous.y}, ${controlX} ${point.y}, ${point.x} ${point.y}`;
      }, "");
    });

    const areaPath = computed(() => {
      const points = chartPoints.value;
      if (!points.length || !chartPath.value) return "";
      const firstPoint = points[0];
      const lastPoint = points[points.length - 1];
      return `${chartPath.value} L ${lastPoint.x} ${chartBottom} L ${firstPoint.x} ${chartBottom} Z`;
    });

    const xAxisLabels = computed(() => {
      const points = chartPoints.value;
      return points;
    });

    const normalizedPaymentDistribution = computed(() => {
      return (paymentDistribution.value || [])
        .map((row) => ({
          mode: row.mode_of_payment || __("Unknown"),
          amount: Number(row.amount) || 0,
        }))
        .filter((row) => row.amount > 0);
    });

    const paymentTotal = computed(() =>
      normalizedPaymentDistribution.value.reduce((total, row) => total + row.amount, 0),
    );

    const hasPaymentData = computed(() => paymentTotal.value > 0);

	    const paymentSegments = computed(() => {
      if (!hasPaymentData.value) return [];

      let offset = 0;
      return normalizedPaymentDistribution.value.map((row, index) => {
        const length = (row.amount / paymentTotal.value) * donutCircumference;
        const segment = {
          ...row,
          color: paymentColors[index % paymentColors.length],
          dashArray: `${length} ${donutCircumference - length}`,
          dashOffset: -offset,
        };
        offset += length;
        return segment;
	      });
	    });

		    const normalizedTopProducts = computed(() => {
		      return (topProducts.value || [])
		        .map((row) => ({
		          item_code: row.item_code || "",
		          item_name: row.item_name || row.item_code || __("Unknown"),
		          total_qty: Number(row.total_qty) || 0,
		          total_sales: Number(row.total_sales) || 0,
		        }))
		        .filter((row) => row.total_qty > 0);
		    });

		    const hasTopProductsData = computed(() => normalizedTopProducts.value.length > 0);

		    const hasProductToggle = computed(
		      () => normalizedTopProducts.value.length > productPreviewLimit,
		    );

		    const visibleTopProducts = computed(() => {
		      const rows = showAllProducts.value
		        ? normalizedTopProducts.value
		        : normalizedTopProducts.value.slice(0, productPreviewLimit);

		      return rows.map((row, index) => ({
		        ...row,
		        rank: index + 1,
		      }));
		    });

		    const normalizedTopCategories = computed(() => {
		      return (topCategories.value || [])
		        .map((row) => ({
		          item_group: row.item_group || __("Unknown"),
		          total_qty: Number(row.total_qty) || 0,
		          total_sales: Number(row.total_sales) || 0,
		        }))
		        .filter((row) => row.total_qty > 0);
		    });

		    const hasTopCategoriesData = computed(() => normalizedTopCategories.value.length > 0);

		    const hasCategoryToggle = computed(
		      () => normalizedTopCategories.value.length > productPreviewLimit,
		    );

		    const maxCategorySales = computed(() =>
		      normalizedTopCategories.value.reduce(
		        (max, row) => Math.max(max, Number(row.total_sales) || 0),
		        0,
		      ),
		    );

		    const visibleTopCategories = computed(() => {
		      const rows = showAllCategories.value
		        ? normalizedTopCategories.value
		        : normalizedTopCategories.value.slice(0, productPreviewLimit);

		      return rows.map((row, index) => ({
		        ...row,
		        rank: index + 1,
		        color: categoryColors[index % categoryColors.length],
		        barWidth: maxCategorySales.value
		          ? Math.max((row.total_sales / maxCategorySales.value) * 100, 2)
		          : 0,
		      }));
		    });

    async function fetchDashboard() {
      loading.value = true;
      error.value = "";

      try {
        const result = await call({
          method: "pospire.pospire.api.dashboard.get_shift_dashboard",
          intent: "read",
        });
        cards.value = {
          ...emptyCards(),
          ...(result?.cards || {}),
        };
        hourlySales.value = {
          ...emptyHourlySales(),
          ...(result?.hourly_sales || {}),
        };
	        paymentDistribution.value = Array.isArray(result?.payment_distribution)
	          ? result.payment_distribution
	          : emptyPaymentDistribution();
	        topProducts.value = Array.isArray(result?.top_products)
	          ? result.top_products
	          : emptyTopProducts();
	        topCategories.value = Array.isArray(result?.top_categories)
	          ? result.top_categories
	          : emptyTopCategories();
	        if ((topProducts.value || []).length <= productPreviewLimit) {
	          showAllProducts.value = false;
	        }
	        if ((topCategories.value || []).length <= productPreviewLimit) {
	          showAllCategories.value = false;
	        }
	      } catch (err) {
	        console.error("[Dashboard] failed to load shift dashboard", err);
	        cards.value = emptyCards();
	        hourlySales.value = emptyHourlySales();
	        paymentDistribution.value = emptyPaymentDistribution();
	        topProducts.value = emptyTopProducts();
	        topCategories.value = emptyTopCategories();
	        showAllProducts.value = false;
	        showAllCategories.value = false;
	        error.value = err?.message || __("Could not load dashboard.");
      } finally {
        loading.value = false;
      }
    }

	    function toggleProductsView() {
	      showAllProducts.value = !showAllProducts.value;
	    }

	    function toggleCategoriesView() {
	      showAllCategories.value = !showAllCategories.value;
	    }

    function formatCardValue(card) {
      const value = Number(cards.value[card.key]) || 0;
      if (card.type === "currency") {
        return `₹${value.toLocaleString("en-IN", {
          maximumFractionDigits: 2,
        })}`;
      }
      return value.toLocaleString("en-IN");
    }

	    function formatCurrency(value) {
	      const number = Number(value) || 0;
	      return `₹${number.toLocaleString("en-IN", {
	        maximumFractionDigits: 2,
	      })}`;
	    }

	    function formatNumber(value) {
	      const number = Number(value) || 0;
	      return number.toLocaleString("en-IN", {
	        maximumFractionDigits: Number.isInteger(number) ? 0 : 2,
	      });
	    }

    function formatCompactCurrency(value) {
      const number = Number(value) || 0;
      const absNumber = Math.abs(number);
      if (absNumber >= 10000000) return `₹${formatCompactNumber(number / 10000000)}Cr`;
      if (absNumber >= 100000) return `₹${formatCompactNumber(number / 100000)}L`;
      if (absNumber >= 1000) return `₹${formatCompactNumber(number / 1000)}K`;
      return `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
    }

    function formatCompactNumber(value) {
      return Number(value).toLocaleString("en-IN", {
        maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
      });
    }

	    function formatHourLabel(value) {
      const hour = Number(String(value).split(":")[0]);
      if (!Number.isFinite(hour)) return value;
      const period = hour >= 12 ? "PM" : "AM";
      const hour12 = hour % 12 || 12;
	      return `${String(hour12).padStart(2, "0")} ${period}`;
	    }

	    function niceTickStep(maxValue, ticks) {
      if (!Number.isFinite(maxValue) || maxValue <= 0) return 1;
      const roughStep = maxValue / Math.max(ticks - 1, 1);
      const magnitude = 10 ** Math.floor(Math.log10(roughStep));
      const normalized = roughStep / magnitude;
      let niceNormalized = 10;
      if (normalized <= 1) {
        niceNormalized = 1;
      } else if (normalized <= 2) {
        niceNormalized = 2;
      } else if (normalized <= 5) {
        niceNormalized = 5;
      }
      return niceNormalized * magnitude;
    }

    onMounted(fetchDashboard);

    return {
      loading,
      error,
      cardItems,
      chartWidth,
      chartHeight,
      chartPadding,
      chartTop,
      chartBottom,
      yTicks,
      chartPoints,
      chartPath,
      areaPath,
      xAxisLabels,
      donutWidth,
      donutHeight,
      donutCenter,
      donutRadius,
	      hasPaymentData,
	      paymentSegments,
	      paymentTotal,
		      hasTopProductsData,
		      hasProductToggle,
		      hasTopCategoriesData,
		      hasCategoryToggle,
		      showAllProducts,
		      showAllCategories,
		      visibleTopProducts,
		      visibleTopCategories,
		      toggleProductsView,
		      toggleCategoriesView,
		      formatCardValue,
		      formatCurrency,
		      formatCompactCurrency,
		      formatHourLabel,
		      formatNumber,
		    };
  },
};
</script>

<style scoped>
.dashboard-page {
  min-height: 100%;
  padding: 16px 18px 32px;
  background: #f5f7fa;
}

.dashboard-page__state {
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dashboard-card {
  height: 116px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.06);
}

.dashboard-page__grid {
  margin-bottom: 20px;
}

.dashboard-card__content {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 18px 20px;
}

.dashboard-card__copy {
  min-width: 0;
}

.dashboard-card__title {
  color: #64748b;
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.3;
  margin-bottom: 8px;
}

.dashboard-card__value {
  color: #0f172a;
  font-size: 2rem;
  font-weight: 700;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.dashboard-card__icon {
  width: 46px;
  height: 46px;
  flex: 0 0 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--card-accent);
  background: var(--card-accent-bg);
}

.dashboard-graphs {
  align-items: stretch;
}

.dashboard-graphs--secondary {
  margin-top: 20px;
}

.dashboard-chart-card {
  height: 390px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.06);
}

.dashboard-chart-card__title {
  color: #0f172a;
  font-size: 1rem;
  font-weight: 600;
  padding: 16px 18px 0;
}

.dashboard-chart-card__body {
  padding: 6px 12px 14px;
}

.dashboard-line-chart {
  width: 100%;
  height: 340px;
  display: block;
}

.dashboard-line-chart__axis {
  stroke: #cbd5e1;
  stroke-width: 1;
}

.dashboard-line-chart__grid {
  stroke: #e2e8f0;
  stroke-width: 1;
}

.dashboard-line-chart__line {
  stroke: #2563eb;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.dashboard-line-chart__area {
  fill: url("#hourly-sales-fill");
}

.dashboard-line-chart__dot {
  fill: #2563eb;
  stroke: #ffffff;
  stroke-width: 2;
}

.dashboard-line-chart__label {
  fill: #64748b;
  font-size: 11px;
}

.dashboard-payment-card__body {
  height: calc(100% - 48px);
}

.dashboard-payment-chart,
.dashboard-payment-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.dashboard-donut-chart {
  width: min(100%, 260px);
  height: 220px;
  display: block;
}

.dashboard-donut-chart__track {
  fill: none;
  stroke: #e5e7eb;
  stroke-width: 24;
}

.dashboard-donut-chart__segment {
  fill: none;
  stroke-width: 24;
  stroke-linecap: round;
}

.dashboard-donut-chart__total-label {
  fill: #64748b;
  font-size: 11px;
  font-weight: 600;
}

.dashboard-donut-chart__total {
  fill: #0f172a;
  font-size: 17px;
  font-weight: 700;
}

.dashboard-donut-chart--empty {
  height: 150px;
}

.dashboard-payment-legend {
  width: min(100%, 360px);
  display: grid;
  gap: 8px;
  margin-top: -8px;
}

.dashboard-payment-legend__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: #334155;
  font-size: 0.8125rem;
}

.dashboard-payment-legend__dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.dashboard-payment-legend__mode {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-payment-legend__amount {
  color: #0f172a;
  font-weight: 600;
}

.dashboard-payment-empty__text {
  color: #64748b;
  font-size: 0.875rem;
  font-weight: 500;
  margin-top: -12px;
}

.dashboard-products-card__body {
  height: calc(100% - 48px);
  overflow: hidden;
  padding: 8px 18px 16px;
}

.dashboard-table-card__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dashboard-table-card__link {
  border: 0;
  padding: 0;
  background: transparent;
  color: #2563eb;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 600;
}

.dashboard-products-table {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dashboard-products-table__header,
.dashboard-products-table__row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 76px 110px;
  align-items: center;
  column-gap: 12px;
}

.dashboard-products-table__header {
  flex: 0 0 auto;
  height: 34px;
  color: #64748b;
  font-size: 0.75rem;
  font-weight: 700;
  border-bottom: 1px solid #e5e7eb;
}

.dashboard-products-table__body {
  min-height: 0;
}

.dashboard-products-table__body--scroll {
  max-height: 360px;
  overflow-y: auto;
  padding-right: 2px;
}

.dashboard-products-table__row {
  height: 40px;
  color: #334155;
  font-size: 0.875rem;
  border-bottom: 1px solid #f1f5f9;
  transition: background-color 0.15s ease;
}

.dashboard-products-table__row:hover {
  background: #f8fafc;
}

.dashboard-products-table__body .dashboard-products-table__row:last-child {
  border-bottom: 0;
}

.dashboard-products-table__rank {
  width: 34px;
  color: #64748b;
  font-weight: 600;
}

.dashboard-products-table__product {
  min-width: 0;
  overflow: hidden;
  color: #0f172a;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-products-table__number {
  justify-self: end;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.dashboard-products-table__sales {
  color: #0f172a;
  font-weight: 700;
}

.dashboard-products-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  font-size: 0.875rem;
  font-weight: 500;
}

.dashboard-categories-chart {
  height: 100%;
  min-height: 0;
}

.dashboard-categories-chart__body {
  display: grid;
  gap: 14px;
  padding-top: 8px;
}

.dashboard-categories-chart__body--scroll {
  max-height: 360px;
  overflow-y: auto;
  padding-right: 2px;
}

.dashboard-categories-chart__row {
  display: grid;
  grid-template-columns: minmax(92px, 0.75fr) minmax(120px, 1.4fr) 96px;
  align-items: center;
  gap: 12px;
  min-height: 38px;
}

.dashboard-categories-chart__name {
  min-width: 0;
  overflow: hidden;
  color: #0f172a;
  font-size: 0.875rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-categories-chart__bar {
  width: 100%;
  height: 12px;
  display: block;
}

.dashboard-categories-chart__track {
  fill: #eef2f7;
}

.dashboard-categories-chart__amount {
  justify-self: end;
  color: #0f172a;
  font-size: 0.875rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

@media (max-width: 600px) {
  .dashboard-products-table__header,
  .dashboard-products-table__row {
    grid-template-columns: 28px minmax(0, 1fr) 54px 92px;
    column-gap: 8px;
  }

  .dashboard-products-card__body {
    padding-inline: 14px;
  }

  .dashboard-categories-chart__row {
    grid-template-columns: minmax(72px, 0.8fr) minmax(80px, 1fr) 84px;
    gap: 8px;
  }
}
</style>
