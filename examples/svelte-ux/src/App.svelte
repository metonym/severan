<script>
  import { Button, Card, Header, Badge, Avatar, Field, TextField, Checkbox, Switch, Toggle, ProgressCircle, Progress, Tabs, Tab, Table, Notification, Tooltip, Icon, Breadcrumb, Paginate, Pagination, Collapse, ListItem, Duration, Shine, Overflow } from "svelte-ux";
</script>
<Card title="Title" subheading="Sub">
  <Header title="Header" subheading="sub" slot="header" />
  <div>Body</div>
</Card>
<Button variant="fill" color="primary">Save</Button>
<Button variant="outline" color="danger" size="sm">Delete</Button>
<Button variant="text" rounded="full">Text</Button>
<Badge value={3} small><span>Inbox</span></Badge>
<Avatar size="lg" class="bg-primary">AB</Avatar>
<TextField label="Name" placeholder="x" />
<TextField label="Notes" multiline />
<Checkbox checked>Agree</Checkbox>
<Switch checked />
<ProgressCircle value={40} />
<Progress value={0.4} />
<ListItem title="Item" subheading="detail" />
<Collapse open><div slot="trigger">More</div><div>Hidden</div></Collapse>
