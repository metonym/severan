<script>
  import { Accordion, Checkbox, Switch, Tabs, Label, Separator, Progress, Toggle, Avatar, Collapsible, RadioGroup, Meter } from "bits-ui";
  let checked = $state(false);
</script>
<Accordion.Root type="single" value="a">
  <Accordion.Item value="a">
    <Accordion.Header><Accordion.Trigger>A</Accordion.Trigger></Accordion.Header>
    <Accordion.Content>Body A</Accordion.Content>
  </Accordion.Item>
  <Accordion.Item value="b" disabled>
    <Accordion.Header><Accordion.Trigger>B</Accordion.Trigger></Accordion.Header>
    <Accordion.Content>Body B</Accordion.Content>
  </Accordion.Item>
</Accordion.Root>
<Label.Root for="c">Check</Label.Root>
<Checkbox.Root id="c" bind:checked />
<Switch.Root checked><Switch.Thumb /></Switch.Root>
<Tabs.Root value="one">
  <Tabs.List><Tabs.Trigger value="one">One</Tabs.Trigger><Tabs.Trigger value="two">Two</Tabs.Trigger></Tabs.List>
  <Tabs.Content value="one">First</Tabs.Content>
  <Tabs.Content value="two">Second</Tabs.Content>
</Tabs.Root>
<Separator.Root orientation="horizontal" />
<Progress.Root value={30} max={100} />
<Toggle.Root pressed>T</Toggle.Root>
<Avatar.Root><Avatar.Image src="x.png" alt="x" /><Avatar.Fallback>AB</Avatar.Fallback></Avatar.Root>
<Collapsible.Root open><Collapsible.Trigger>Toggle</Collapsible.Trigger><Collapsible.Content>Inside</Collapsible.Content></Collapsible.Root>
<RadioGroup.Root value="x"><RadioGroup.Item value="x" /><RadioGroup.Item value="y" /></RadioGroup.Root>
<Meter.Root value={4} min={0} max={10} />
