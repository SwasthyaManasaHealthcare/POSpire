<template>
  <v-row class="widget-grid" dense>
    <v-col
      v-for="(item, index) in resolvedWidgets"
      :key="index"
      cols="12"
      :md="item.cols"
    >
      <v-card
        v-if="item.type !== 'number-card'"
        class="widget-grid__card"
        elevation="1"
      >
        <v-card-title v-if="item.props.title" class="widget-grid__title">
          {{ item.props.title }}
        </v-card-title>
        <v-card-text class="widget-grid__body">
          <component :is="item.component" v-bind="item.props" />
        </v-card-text>
      </v-card>
      <component :is="item.component" v-else v-bind="item.props" />
    </v-col>
  </v-row>
</template>

<script>
import { computed } from "vue";
import { REGISTRY } from "./registry";
import { resolveWidget } from "./catalog";

export default {
	name: "WidgetRenderer",
	props: {
		layout: { type: Array, default: () => [] },
		data: { type: Object, default: () => ({}) },
	},
	setup(props) {
		const resolvedWidgets = computed(() => {
			const items = [];
			for (const descriptor of props.layout) {
				const slice = props.data?.[descriptor.data_key];
				const resolved = resolveWidget(descriptor, slice);
				const component = resolved && REGISTRY[resolved.type];
				if (!resolved || !component) {
					if (import.meta.env.DEV) {
						console.warn("[WidgetRenderer] skipping widget", descriptor);
					}
					continue;
				}
				items.push({
					component,
					type: resolved.type,
					props: resolved.props,
					cols: Math.min(Math.max(resolved.colSpan, 1), 12),
				});
			}
			return items;
		});

		return { resolvedWidgets };
	},
};
</script>

<style scoped>
.widget-grid {
	align-items: stretch;
}
.widget-grid__card {
	height: 390px;
	background: #ffffff;
	border: 1px solid #e5e7eb;
	border-radius: 14px;
	box-shadow: 0 8px 22px rgba(15, 23, 42, 0.06);
}
.widget-grid__title {
	color: #0f172a;
	font-size: 1rem;
	font-weight: 600;
	padding: 16px 18px 0;
}
.widget-grid__body {
	height: calc(100% - 48px);
	padding: 8px 18px 16px;
}
</style>
