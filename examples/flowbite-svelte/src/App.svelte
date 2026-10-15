<script>
  import { Button, Badge, Alert, Card, Avatar, Spinner, Progressbar, Toggle, Checkbox, Input, Label, Select, Textarea, Heading, P, Hr, Indicator, Kbd, Rating, Breadcrumb, BreadcrumbItem, Tabs, TabItem, Accordion, AccordionItem, Table, TableHead, TableHeadCell, TableBody, TableBodyRow, TableBodyCell, List, Li, Navbar, NavBrand, NavLi, NavUl, Footer, FooterCopyright } from "flowbite-svelte";
</script>
<Navbar><NavBrand href="/">Brand</NavBrand><NavUl><NavLi href="/">Home</NavLi><NavLi href="/about">About</NavLi></NavUl></Navbar>
<Heading tag="h2">Title</Heading>
<P size="lg">Paragraph</P>
<Hr />
<Breadcrumb><BreadcrumbItem href="/" home>Home</BreadcrumbItem><BreadcrumbItem>Page</BreadcrumbItem></Breadcrumb>
<Button color="red" size="sm">Red</Button>
<Button color="alternative" pill>Pill</Button>
<Button outline color="green">Outline</Button>
<Badge color="green" large>New</Badge>
<Badge dismissable={false}>Plain</Badge>
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
<Select items={[{ value: "a", name: "A" }]} />
<Textarea rows={3} />
<Indicator color="red" />
<Kbd>Ctrl</Kbd>
<Rating total={5} size={20} rating={3} />
<Tabs><TabItem open title="One">First</TabItem><TabItem title="Two">Second</TabItem></Tabs>
<Accordion><AccordionItem open><span slot="header">H</span>Body</AccordionItem></Accordion>
<Table striped>
  <TableHead><TableHeadCell>Name</TableHeadCell></TableHead>
  <TableBody><TableBodyRow><TableBodyCell>A</TableBodyCell></TableBodyRow></TableBody>
</Table>
<List tag="ol"><Li>One</Li><Li>Two</Li></List>
<Footer><FooterCopyright href="/" by="Me" year={2026} /></Footer>
