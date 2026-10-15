<script>
  import { Navbar, NavbarBrand, Nav, NavItem, NavLink, Container, Row, Col, Card, CardHeader, CardBody, CardTitle, CardText, Button, Badge, Alert, Form, FormGroup, Label, Input, Table, Progress, Spinner, ListGroup, ListGroupItem, Breadcrumb, BreadcrumbItem, Pagination, PaginationItem, PaginationLink } from "@sveltestrap/sveltestrap";
</script>
<Navbar color="dark" dark expand="md"><NavbarBrand href="/">App</NavbarBrand><Nav class="ms-auto" navbar><NavItem><NavLink href="/a">A</NavLink></NavItem></Nav></Navbar>
<Container>
  <Breadcrumb><BreadcrumbItem><a href="/">Home</a></BreadcrumbItem><BreadcrumbItem active>Page</BreadcrumbItem></Breadcrumb>
  <Row>
    <Col md="8">
      <Card><CardHeader>Header</CardHeader><CardBody><CardTitle>Title</CardTitle><CardText>Text</CardText><Button color="primary">Go</Button> <Button color="secondary" outline size="sm">Cancel</Button></CardBody></Card>
      <Alert color="warning">Careful</Alert>
      <Form><FormGroup><Label for="e">Email</Label><Input type="email" id="e" /></FormGroup><FormGroup><Label for="s">Pick</Label><Input type="select" id="s"><option>1</option></Input></FormGroup><Button type="submit" color="success">Save</Button></Form>
    </Col>
    <Col md="4">
      <ListGroup><ListGroupItem>One <Badge color="info" pill>2</Badge></ListGroupItem><ListGroupItem active>Two</ListGroupItem></ListGroup>
      <Progress value={60} color="success" />
      <Spinner color="primary" size="sm" />
    </Col>
  </Row>
  <Table striped bordered><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></Table>
  <Pagination><PaginationItem><PaginationLink first href="#" /></PaginationItem><PaginationItem active><PaginationLink href="#">1</PaginationLink></PaginationItem></Pagination>
</Container>
