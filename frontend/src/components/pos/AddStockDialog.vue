<template>
  <v-dialog v-model="dialog" max-width="500px">
    <v-card class="pa-4">
      <v-card-title class="text-h6 d-flex justify-center align-center">
        <v-icon start>mdi-plus-box</v-icon>
        {{ __("Add to Stock") }}
      </v-card-title>
      <v-card-text>
        <v-text-field
          :label="__('Item')"
          v-model="item_name"
          readonly
          variant="outlined"
          class="mb-3"
        />
        <v-text-field
          :label="__('Warehouse')"
          v-model="warehouse"
          variant="outlined"
          class="mb-3"
        />
        <v-text-field
          :label="__('Quantity')"
          v-model="qty"
          type="number"
          variant="outlined"
          class="mb-3"
        />
        <v-textarea
          v-if="has_serial_no"
          :label="__('Serial Numbers (one per line)')"
          v-model="serial_nos"
          variant="outlined"
          rows="3"
        />
        <div v-if="has_batch_no">
          <v-text-field
            :label="__('Batch No')"
            v-model="batch_no"
            variant="outlined"
            class="mb-2"
          />
          <v-text-field
            :label="__('Expiry Date')"
            v-model="expiry_date"
            type="date"
            variant="outlined"
          />
        </div>

      </v-card-text>
      <v-card-actions class="justify-end">
        <v-btn text @click="dialog = false">
          {{ __("Cancel") }}
        </v-btn>

        <v-btn
          class="btn-primary-action"
          @click="submitStock"
        >
          {{ __("Submit") }}
        </v-btn>
      </v-card-actions>

    </v-card>
  </v-dialog>
</template>
<script>
import { call } from "frappe-ui";
import { toast } from "vue3-toastify";
export default {
  data() {
    return {
      dialog: false,
      item_code: "",
      item_name: "",
      has_serial_no: false,
      has_batch_no: false,
      warehouse: "",
      qty: 1,
      serial_nos: "",
      batch_no: "",
      expiry_date: "",
    };
  },

  methods: {
    open(data) {
      this.dialog = true;

      this.item_code = data.item_code;
      this.item_name = data.item_name;
      this.has_serial_no = data.has_serial_no;
      this.has_batch_no = data.has_batch_no;

      this.qty = data.qty || 1;
      this.warehouse = data.warehouse || "";
    },
    async submitStock(){
        if (!this.qty || this.qty <= 0) {
            toast.error(__("Quantity must be greater than 0"));
            return;
        }
        if (!this.warehouse) {
            toast.error(__("Warehouse is required"));
            return;
        }
        if (this.has_serial_no) {
            const count = this.serial_nos
                .split("\n")
                .filter(s => s.trim()).length;

            if (count !== Number(this.qty)) {
                toast.error(__("Serial count must match quantity"));
                return;
            }
        }
        try {
            await call(
                "pospire.pospire.api.posapp.create_pos_stock_entry",
                {
                    item_code: this.item_code,
                    qty: this.qty,
                    warehouse: this.warehouse,
                    serial_nos: this.serial_nos,
                    batch_no: this.batch_no,
                    expiry_date: this.expiry_date,
                }
            );
            this.$emit("stock-added");
            this.dialog = false;

            this.serial_nos = "";
            this.batch_no = "";
            this.expiry_date = "";
        } catch(e){
            console.error(e);
            let message = e?.message || "";
            if (message.includes(":")) {
                message = message.split(":").pop().trim();
            }
            toast.error(message || __("Failed to add stock"));
        }
    }
  },
  watch: {
    serial_nos(val) {
        if (this.has_serial_no) {
            this.qty = val
                .split("\n")
                .filter(s => s.trim()).length || 0;
        }
    }
    }
};
</script>