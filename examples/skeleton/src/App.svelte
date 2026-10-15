<script>
  import { Avatar, Progress, Switch, Tabs, Accordion, Collapsible } from "@skeletonlabs/skeleton-svelte";
</script>
<Avatar><Avatar.Image src="x.png" /><Avatar.Fallback>SK</Avatar.Fallback></Avatar>
<Progress value={40} max={100}><Progress.Label>Load</Progress.Label><Progress.Track><Progress.Range /></Progress.Track></Progress>
<Switch checked><Switch.Control><Switch.Thumb /></Switch.Control><Switch.Label>On</Switch.Label><Switch.HiddenInput /></Switch>
<Tabs defaultValue="a"><Tabs.List><Tabs.Trigger value="a">A</Tabs.Trigger><Tabs.Trigger value="b">B</Tabs.Trigger></Tabs.List><Tabs.Content value="a">AA</Tabs.Content><Tabs.Content value="b">BB</Tabs.Content></Tabs>
<Accordion defaultValue={["x"]}><Accordion.Item value="x"><Accordion.ItemTrigger>X</Accordion.ItemTrigger><Accordion.ItemContent>XX</Accordion.ItemContent></Accordion.Item></Accordion>
<Collapsible defaultOpen><Collapsible.Trigger>T</Collapsible.Trigger><Collapsible.Content>C</Collapsible.Content></Collapsible>
