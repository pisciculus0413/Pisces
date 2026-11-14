<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProviderInfo, SessionMeta } from "../protocol.js";

const props = defineProps<{
  providers: ProviderInfo[];
  meta: SessionMeta | null;
  busy: boolean;
}>();
const emit = defineEmits<{ configure: [provider: string, model: string] }>();

const provider = ref(props.meta?.provider ?? "");
const model = ref(props.meta?.model ?? "");

watch(
  () => props.meta,
  (meta) => {
    provider.value = meta?.provider ?? "";
    model.value = meta?.model ?? "";
  },
);

const models = computed(
  () => props.providers.find((item) => item.id === provider.value)?.models ?? [],
);
const contextWindow = computed(
  () => models.value.find((item) => item.id === model.value)?.contextWindow ?? null,
);

function apply(): void {
  if (provider.value === "" || model.value === "") return;
  emit("configure", provider.value, model.value);
}
</script>

<template>
  <div>
    <h3>模型</h3>
    <div class="row">
      <select v-model="provider" :disabled="busy" @change="model = ''">
        <option value="" disabled>provider</option>
        <option v-for="item in providers" :key="item.id" :value="item.id">
          {{ item.id }}{{ item.ready ? "" : "（未就绪）" }}
        </option>
      </select>
      <select v-model="model" :disabled="busy">
        <option value="" disabled>model</option>
        <option v-for="item in models" :key="item.id" :value="item.id">{{ item.id }}</option>
      </select>
      <button type="button" :disabled="busy || provider === '' || model === ''" @click="apply">
        切换
      </button>
    </div>
    <div v-if="contextWindow !== null" class="kv">
      <span>contextWindow</span><span>{{ contextWindow }}</span>
    </div>
    <div v-if="meta" class="kv"><span>workspace</span><span>{{ meta.workspace }}</span></div>
  </div>
</template>
