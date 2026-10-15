<script>
  import { Button, Badge, Alert, Card, Avatar, Spinner, Progressbar, Toggle, Checkbox, Input, Label, Heading, P, Hr, Indicator, Kbd, Breadcrumb, BreadcrumbItem, Accordion, AccordionItem, List, Li } from "svelte-5-ui-lib";
</script>
<Heading tag="h2">Title</Heading>
<P size="lg">Paragraph</P>
<Hr />
<Breadcrumb><BreadcrumbItem href="/" home>Home</BreadcrumbItem><BreadcrumbItem>Page</BreadcrumbItem></Breadcrumb>
<Button color="red" size="sm">Red</Button>
<Button color="alternative" pill>Pill</Button>
<Button outline color="green">Outline</Button>
<Badge color="green" large>New</Badge>
<Alert color="blue">Info</Alert>
<Alert color="red" border>Error</Alert>
<Card href="/x" size="md">Card body</Card>
<Avatar rounded size="lg" />
<Spinner color="purple" size="6" />
<Progressbar progress={45} size="h-2" />
<Toggle checked>Toggle</Toggle>
<Label for="i">Name</Label>
<Input id="i" size="sm" placeholder="x" />
<Checkbox checked>Check</Checkbox>
<Indicator color="red" />
<Kbd>Ctrl</Kbd>
<Accordion><AccordionItem open>{#snippet header()}H{/snippet}Body</AccordionItem></Accordion>
<List tag="ol"><Li>One</Li><Li>Two</Li></List>
