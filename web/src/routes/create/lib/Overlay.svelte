<script lang="ts">
    let {children} = $props()
</script>

<div class="fixed inset-0 bg-neutral-900/90 backdrop-blur-md flex align-middle place-items-center justify-center font-mono">
  {@render (children?.())}
    
</div>