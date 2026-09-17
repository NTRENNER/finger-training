import React from "react";
import {render,screen,fireEvent} from "@testing-library/react";
import {ClimbingHistoryList} from "../ClimbingHistoryList.js";
import {saveLS,LS_CLIMBING_HISTORY_FILTERS_KEY} from "../../lib/storage.js";

const climb={id:"climb",type:"climbing",date:"2026-09-16",discipline:"boulder",venue:"indoor",wall:"commercial",grade:"V4",ascent:"flash",attempts:10,rpe:7};
beforeEach(()=>saveLS(LS_CLIMBING_HISTORY_FILTERS_KEY,null));
test("a mistaken attempt count can be corrected to one and saved as a flash",()=>{
 const onUpdateActivity=jest.fn();render(<ClimbingHistoryList climbs={[climb]} onUpdateActivity={onUpdateActivity}/>);
 fireEvent.click(screen.getByTitle("Edit climb"));
 expect(screen.getByLabelText("Attempts")).toHaveValue(10);
 expect(screen.getByRole("button",{name:"Flash",exact:true})).toBeDisabled();
 fireEvent.change(screen.getByLabelText("Attempts"),{target:{value:"1"}});
 fireEvent.click(screen.getByRole("button",{name:"Flash",exact:true}));
 fireEvent.click(screen.getByRole("button",{name:"Save",exact:true}));
 expect(onUpdateActivity).toHaveBeenCalledWith("climb",expect.objectContaining({attempts:null,ascent:"flash"}));
});
test("saving an older contradictory entry corrects the ascent while retaining attempts",()=>{
 const onUpdateActivity=jest.fn();render(<ClimbingHistoryList climbs={[climb]} onUpdateActivity={onUpdateActivity}/>);
 fireEvent.click(screen.getByTitle("Edit climb"));
 fireEvent.click(screen.getByRole("button",{name:"Save",exact:true}));
 expect(onUpdateActivity).toHaveBeenCalledWith("climb",expect.objectContaining({attempts:10,ascent:"redpoint"}));
});
