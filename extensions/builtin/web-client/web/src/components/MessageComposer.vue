<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ steering: boolean; busy: boolean }>();
const emit = defineEmits<{ send: [text: string] }>();

const draft = ref("");
const input = ref<HTMLTextAreaElement | null>(null);

function submit(): void {
  const text = draft.value.trim();
  if (text === "" || props.busy) return;
  emit("send", text);
  draft.value = "";
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="composer">
    <textarea
      ref="input"
      v-model="draft"
      :placeholder="steering ? '继续发送（追加到当前 turn）…' : '发送消息并开始 turn…'"
      @keydown="onKeydown"
    />
    <div class="composer-foot">
      <span>{{ steering ? "追加（steer）" : "发送并开始 turn" }}</span>
      <span>Enter 发送 · Shift+Enter 换行</span>
      <span class="spacer" />
      <button class="primary" type="button" :disabled="busy || draft.trim() === ''" @click="submit">
        发送
      </button>
    </div>
  </div>
</template>
